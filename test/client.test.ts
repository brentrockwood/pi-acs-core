import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcsClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { newSessionState, toolCallPayload } from "../src/mapper.js";
import { createGuardian, TEST_KEY, type TestGuardian } from "./guardian-helper.js";

describe("Guardian client", () => {
  let guardian: TestGuardian | undefined;

  beforeEach(() => {
    process.env.PI_ACS_TEST_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.PI_ACS_TEST_KEY;
    vi.unstubAllGlobals();
    guardian = undefined;
  });

  function client(url: string, connectTimeoutMs = 100): AcsClient {
    return new AcsClient(parseConfig({
      mode: "enforce",
      startupPosture: "refuse",
      guardian: { url, connectTimeoutMs, hmacKeyEnv: "PI_ACS_TEST_KEY", keyId: "test-key" },
    }, "/work"));
  }

  it("handshakes, signs traffic, correlates ids, and returns a deny", async () => {
    guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? { result: { decision: "deny", reasoning: "test deny" } }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    const result = await acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" }));
    expect(result).toMatchObject({ decision: "deny", reasoning: "test deny" });
    expect(guardian.requests).toHaveLength(2);
    expect(guardian.requests.every((request) => request.params.signature !== undefined)).toBe(true);
  });

  it("classifies malformed JSON and timeouts", async () => {
    guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? { raw: "{broken" }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    await expect(acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" })))
      .rejects.toMatchObject({ kind: "invalid_json" });

    guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? { delayMs: 60 }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const timeoutState = newSessionState();
    const timeoutClient = client(guardian.url, 20);
    timeoutState.handshake = await timeoutClient.handshake(timeoutState);
    timeoutState.handshake.timeout_config.default_ms = 20;
    await expect(timeoutClient.request(timeoutState, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" })))
      .rejects.toMatchObject({ kind: "timeout" });
  });

  it("sends system/ping without a signature", async () => {
    guardian = createGuardian();
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    const result = await acs.request(state, "system/ping", { echo: "hello" });
    expect(result.decision).toBe("allow");
    expect(guardian.requests.at(-1)?.params.signature).toBeUndefined();
  });

  it("rejects a response signed under an unexpected key id", async () => {
    guardian = createGuardian();
    const originalFetch = guardian.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      const value = await response.json() as any;
      if (value.result?.signature) value.result.signature.key_id = "different-key";
      return Response.json(value);
    });
    const state = newSessionState();
    const acs = client(guardian.url);
    await expect(acs.handshake(state)).rejects.toMatchObject({ kind: "signature" });
  });

  it("verifies signed JSON-RPC error envelopes before surfacing the error", async () => {
    guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? { error: { code: -32001, message: "Guardian rejected the request" } }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    await expect(acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" })))
      .rejects.toMatchObject({ kind: "guardian_error", message: "Guardian rejected the request" });

    const originalFetch = guardian.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      const value = await response.json() as { error?: { signature?: unknown } };
      if (value.error) delete value.error.signature;
      return Response.json(value);
    });
    await expect(acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" })))
      .rejects.toMatchObject({ kind: "signature" });
  });

  it("serializes same-session requests so the next request carries the prior chain head", async () => {
    let sequence = 0;
    guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? { result: { decision: "allow", chain_hash: (++sequence).toString(16).padStart(64, "0") } }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    await Promise.all([
      acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "one" })),
      acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "two" })),
    ]);
    const calls = guardian.requests.filter((request) => request.method === "steps/toolCallRequest");
    expect(calls[0]?.params.metadata.session_state).toBeUndefined();
    expect(calls[1]?.params.metadata.session_state?.chain_hash).toBe("1".padStart(64, "0"));
  });

  it("rejects payloads larger than the advertised client limit before transport", async () => {
    guardian = createGuardian();
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    await expect(acs.request(state, "steps/userMessage", {
      content: [{ type: "text", value: "x".repeat(1_048_576) }],
    })).rejects.toMatchObject({ kind: "request_too_large" });
    expect(guardian.requests).toHaveLength(1);
  });
});
