import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcsClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { deriveSessionKey, signEnvelope, verifyEnvelope } from "../src/crypto.js";
import { failureDisposition } from "../src/failure.js";
import { newSessionState, toolCallPayload } from "../src/mapper.js";
import type { AcsRequestEnvelope, AcsResponseEnvelope, ServerHello } from "../src/types.js";
import { createGuardian, TEST_KEY, TEST_KEY_ID } from "./guardian-helper.js";

const method = "steps/toolCallRequest";
const payload = toolCallPayload("bash", { command: "pwd" });
const session = () => newSessionState();

function client(url = "http://127.0.0.1:8787/"): AcsClient {
  return new AcsClient(parseConfig({
    mode: "enforce",
    guardian: { url, connectTimeoutMs: 2_000, hmacKeyEnv: "ACS_BOUNDARY_TEST_KEY", keyId: TEST_KEY_ID },
  }, "/work"));
}

function resign(envelope: AcsResponseEnvelope, request: AcsRequestEnvelope): void {
  const key = deriveSessionKey(TEST_KEY, request.params.metadata.session_id);
  const signature = signEnvelope(envelope, key, TEST_KEY_ID);
  if (envelope.result) envelope.result.signature = signature;
  if (envelope.error) envelope.error.signature = signature;
  expect(verifyEnvelope(envelope, key, signature)).toBe(true);
}

// Real fetch must keep its abort signal active after headers and across body chunks.
async function withServer(
  timeout: ServerHello["timeout_config"],
  send: (response: ServerResponse, body: string) => void,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const guardian = createGuardian();
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const envelope = JSON.parse(body) as AcsRequestEnvelope;
      const reply = await guardian.fetch("http://127.0.0.1/", { body });
      const value = await reply.json() as AcsResponseEnvelope;
      if (envelope.method === "handshake/hello") {
        (value.result as ServerHello).timeout_config = timeout;
        resign(value, envelope);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      if (envelope.method === "handshake/hello") response.end(JSON.stringify(value));
      else send(response, JSON.stringify(value));
    } catch (error) {
      response.destroy(error as Error);
    }
  });
  // A broken client cannot keep this fixture or its sockets alive indefinitely.
  server.setTimeout(2_500, (socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    await run(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

function delayedBody(response: ServerResponse, body: string): void {
  const timer = setTimeout(() => response.end(body), 400);
  response.once("close", () => clearTimeout(timer));
}

beforeEach(() => vi.stubEnv("ACS_BOUNDARY_TEST_KEY", TEST_KEY));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("HTTP response deadlines", () => {
  it.each(["stalled", "dripping"] as const)("times out a %s body after prompt headers", async (mode) => {
    let sent = 0;
    await withServer({ default_ms: 300 }, (response, body) => {
      response.write(body.slice(0, 1));
      sent++;
      const drip = mode === "dripping" ? setInterval(() => { response.write(" "); sent++; }, 40) : undefined;
      const stop = setTimeout(() => response.destroy(), 2_000);
      response.once("close", () => { clearInterval(drip); clearTimeout(stop); });
    }, async (url) => {
      const acs = client(url);
      const state = session();
      state.handshake = await acs.handshake(state);
      const start = performance.now();
      const error = await acs.request(state, method, payload).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind: "timeout", message: "Guardian timed out after 300 ms" });
      expect(failureDisposition(error)).toBe("availability");
      expect(performance.now() - start).toBeGreaterThanOrEqual(250);
      expect(performance.now() - start).toBeLessThan(1_200);
      expect(sent).toBeGreaterThanOrEqual(mode === "dripping" ? 3 : 1);
    });
  });

  it.each([
    { name: "default deadline", timeout: { default_ms: 120 }, explicit: undefined, expires: 120 },
    { name: "shorter method deadline", timeout: { default_ms: 1_500, per_method_ms: { [method]: 120 } }, explicit: undefined, expires: 120 },
    { name: "longer method deadline", timeout: { default_ms: 120, per_method_ms: { [method]: 1_500 } }, explicit: undefined, expires: undefined },
    { name: "unrelated method uses default", timeout: { default_ms: 120, per_method_ms: { "steps/sessionEnd": 1_500 } }, explicit: undefined, expires: 120 },
    { name: "success within default", timeout: { default_ms: 1_500 }, explicit: undefined, expires: undefined },
    { name: "explicit deadline overrides method", timeout: { default_ms: 1_500, per_method_ms: { [method]: 1_500 } }, explicit: 120, expires: 120 },
    { name: "explicit deadline can extend method", timeout: { default_ms: 120, per_method_ms: { [method]: 120 } }, explicit: 1_500, expires: undefined },
  ])("honors $name", async ({ timeout, explicit, expires }) => {
    await withServer(timeout, delayedBody, async (url) => {
      const acs = client(url);
      const state = session();
      state.handshake = await acs.handshake(state);
      const result = acs.request(state, method, payload, explicit);
      if (expires !== undefined) {
        await expect(result).rejects.toMatchObject({ kind: "timeout", message: `Guardian timed out after ${expires} ms` });
      } else {
        await expect(result).resolves.toMatchObject({ decision: "allow" });
      }
    });
  });
});

describe("authenticated response binding", () => {
  it.each(["request_id", "hello id", "error id", "result and error"] as const)("rejects signed %s independently of signature verification", async (fault) => {
    const guardian = createGuardian((request) => fault === "error id" && request.method === method
      ? { error: { code: -32603, message: "internal" } }
      : {});
    let modified = false;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const reply = await guardian.fetch(input, init);
      const request = JSON.parse(String(init?.body)) as AcsRequestEnvelope;
      const envelope = await reply.json() as AcsResponseEnvelope;
      const target = fault === "hello id" ? "handshake/hello" : method;
      if (request.method === target) {
        if ((fault === "request_id" || fault === "result and error") && envelope.result && "request_id" in envelope.result) {
          envelope.result.chain_hash = "b".repeat(64);
        }
        if (fault === "request_id" && envelope.result && "request_id" in envelope.result) {
          envelope.result.request_id = randomUUID();
          expect(envelope.id).toBe(request.id);
          expect(envelope.result.request_id).not.toBe(request.params.request_id);
        } else if (fault === "hello id" || fault === "error id") {
          envelope.id = "wrong-jsonrpc-id";
        } else if (fault === "result and error") {
          envelope.error = { code: -32603, message: "contradictory error" };
        }
        resign(envelope, request);
        modified = true;
      }
      return Response.json(envelope);
    });
    const acs = client();
    const state = session();
    state.chainHash = "a".repeat(64);
    const attempt = async () => {
      state.handshake = await acs.handshake(state);
      return acs.request(state, method, payload);
    };
    const error = await attempt().catch((caught: unknown) => caught);
    expect(modified).toBe(true);
    expect(error).toMatchObject({ kind: fault === "result and error" ? "invalid_schema" : "correlation" });
    expect(failureDisposition(error)).toBe("integrity");
    expect(state.chainHash).toBe("a".repeat(64));
  });
});
