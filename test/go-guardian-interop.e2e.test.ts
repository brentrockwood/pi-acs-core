/** Optional wire checks against the pinned Go/AGT Guardian; see docs/go-guardian-interop.md. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AcsClient } from "../src/client.js";
import { parseConfig, type AcsConfig } from "../src/config.js";
import { deriveSessionKey, signEnvelope } from "../src/crypto.js";
import { failureDisposition } from "../src/failure.js";
import { METHODS_IMPLEMENTED, buildRequest, newSessionState, toolCallPayload, toolResultPayload } from "../src/mapper.js";
import type { AcsClientError, AcsResponseEnvelope } from "../src/types.js";

const url = process.env.ACS_GO_GUARDIAN_URL;
const keyEnv = "PI_ACS_GO_INTEROP_KEY";
const keyId = "go-interop-key";
const realFetch = globalThis.fetch;

describe.skipIf(!url)("Go AGT Guardian interoperability", () => {
  let config: AcsConfig;
  let acs: AcsClient;

  beforeAll(() => {
    const endpoint = new URL(url!);
    if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:") {
      throw new Error("Run this synthetic-data suite against a loopback HTTP Guardian only");
    }
    config = parseConfig({
      mode: "enforce",
      guardian: { url, hmacKeyEnv: keyEnv, keyId, connectTimeoutMs: 5_000 },
    }, process.cwd());
    acs = new AcsClient(config);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("verifies the signed negotiated handshake", async () => {
    const state = newSessionState();
    const hello = state.handshake = await acs.handshake(state);
    expect(hello).toMatchObject({
      negotiated_version: "0.1.0",
      selected_transport: "http",
      signature_algorithms_supported: ["HMAC-SHA256"],
      signature: { algorithm: "HMAC-SHA256", key_id: keyId },
    });
    // Go advertises evaluated hooks, not the separately dispatched liveness method.
    expect(new Set(hello.methods_evaluated)).toEqual(new Set(METHODS_IMPLEMENTED.filter((method) => method !== "system/ping")));
    expect(hello.profiles_accepted ?? []).toEqual([]);
    expect(await acs.request(state, "system/ping", {})).toMatchObject({ decision: "allow" });
    expect(state.chainHash).toBeUndefined();
  });

  it("verifies signed allow, linked tool result, deny, and session end", async () => {
    const state = newSessionState();
    state.handshake = await acs.handshake(state);
    const start = await acs.request(state, "steps/sessionStart", {});
    expect(start.decision).toBe("allow");
    const allowed = await acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "ls -la" }));
    expect(allowed).toMatchObject({ decision: "allow", signature: { key_id: keyId } });
    expect(allowed.chain_hash).toMatch(/^[0-9a-f]{64}$/);
    const result = await acs.request(state, "steps/toolCallResult", toolResultPayload(
      "bash", allowed.request_id, [{ type: "text", text: "synthetic clean output" }], false,
    ));
    expect(result).toMatchObject({ decision: "allow", signature: { key_id: keyId } });
    // This is policy input only, never a command executed by this wire-level test.
    const denied = await acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "echo harmless # rm -rf /" }));
    expect(denied).toMatchObject({ decision: "deny", signature: { key_id: keyId } });
    expect(denied.reason_codes).toContain("destructive_shell_command_blocked");
    expect(new Set([start.chain_hash, allowed.chain_hash, result.chain_hash, denied.chain_hash]).size).toBe(4);
    expect(state.chainHash).toBe(denied.chain_hash);
    const end = await acs.request(state, "steps/sessionEnd", { reason: "completed" });
    expect(end).toMatchObject({ decision: "allow", signature: { key_id: keyId } });
  });

  it("rejects a request with an invalid HMAC instead of issuing a decision", async () => {
    const state = newSessionState();
    state.handshake = await acs.handshake(state);
    const envelope = buildRequest(config, state, "steps/toolCallRequest", toolCallPayload("bash", { command: "ls -la" }));
    envelope.params.signature = signEnvelope(envelope, deriveSessionKey(process.env[keyEnv]!, state.sessionId), keyId);
    envelope.params.signature.value = Buffer.alloc(32).toString("base64");
    const response = await realFetch(url!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
      signal: AbortSignal.timeout(5_000),
      redirect: "error",
    });
    const answer = await response.json() as AcsResponseEnvelope;
    expect(answer.id).toBe(envelope.id);
    expect(answer.error).toMatchObject({ code: -32004 });
    expect(answer.result).toBeUndefined();
  });

  it("rejects a tampered Guardian decision as an integrity failure even under proceed", async () => {
    const state = newSessionState();
    state.handshake = await acs.handshake(state);
    const permissive = new AcsClient({ ...config, decisionFailurePosture: "proceed" });
    state.handshake.on_decision_failure = "proceed";
    expect(permissive.failurePosture(state)).toBe("proceed");
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      const answer = await response.json() as AcsResponseEnvelope;
      if (answer.result) answer.result.reasoning = "tampered after signing";
      return Response.json(answer, { status: response.status });
    });
    const error: unknown = await permissive.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "ls -la" }))
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({ kind: "signature" });
    expect(failureDisposition(error as AcsClientError)).toBe("integrity");
  });
});
