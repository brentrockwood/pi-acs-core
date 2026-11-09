import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcsClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { failureDisposition } from "../src/failure.js";
import { newSessionState, toolCallPayload } from "../src/mapper.js";
import type { ServerHello } from "../src/types.js";
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

  it("accepts a signed direct ServerHello over HTTP, correlates ids, and returns a deny", async () => {
    guardian = createGuardian((request) => {
      if (request.method === "handshake/hello") return { directHello: true };
      return request.method === "steps/toolCallRequest"
        ? { result: { decision: "deny", reasoning: "test deny" } }
        : {};
    });
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    const result = await acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" }));
    expect(result).toMatchObject({ decision: "deny", reasoning: "test deny" });
    expect(guardian.requests).toHaveLength(2);
    expect(guardian.requests.every((request) => request.params.signature !== undefined)).toBe(true);
  });

  it("rejects an unsigned direct ServerHello over HTTP", async () => {
    guardian = createGuardian((request) => request.method === "handshake/hello"
      ? { directHello: true, unsignedHello: true }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await expect(client(guardian.url).handshake(newSessionState()))
      .rejects.toMatchObject({ kind: "signature" });
  });

  it("rejects tampered signed direct and legacy wrapped ServerHello responses", async () => {
    guardian = createGuardian();
    const signedFetch = guardian.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await signedFetch(input, init);
      const value = await response.json() as { result?: ServerHello };
      if (value.result?.negotiated_version) value.result.on_decision_failure = "proceed";
      return Response.json(value);
    });
    await expect(client(guardian.url).handshake(newSessionState()))
      .rejects.toMatchObject({ kind: "signature" });

    guardian = createGuardian((request) => request.method === "handshake/hello" ? { legacyHello: true } : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await expect(client(guardian.url).handshake(newSessionState()))
      .rejects.toMatchObject({ kind: "invalid_schema" });
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

    const errorGuardian = createGuardian((request) => request.method === "system/ping"
      ? { error: { code: -32001, message: "Ping unavailable" } }
      : {});
    vi.stubGlobal("fetch", errorGuardian.fetch);
    const errorState = newSessionState();
    const errorClient = client(errorGuardian.url);
    errorState.handshake = await errorClient.handshake(errorState);
    await expect(errorClient.request(errorState, "system/ping", {}))
      .rejects.toMatchObject({ kind: "guardian_error", message: "Ping unavailable" });
  });

  it("rejects a response signed under an unexpected key id", async () => {
    guardian = createGuardian();
    const originalFetch = guardian.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await originalFetch(input, init);
      const request = JSON.parse(String(init?.body)) as { method?: string };
      const value = await response.json() as any;
      if (request.method === "steps/toolCallRequest" && value.result?.signature) {
        value.result.signature.key_id = "different-key";
      }
      return Response.json(value);
    });
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    await expect(acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" })))
      .rejects.toMatchObject({ kind: "signature" });
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

  it("keeps the JSON-RPC error code so a refusal is distinguishable from an internal error", async () => {
    guardian = createGuardian((request) => request.method === "handshake/hello"
      ? { error: { code: -32000, message: "agent not permitted", data: { reason: "agent_id" } } }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const refused = await client(guardian.url).handshake(newSessionState()).catch((error: unknown) => error);
    expect(refused).toMatchObject({ kind: "guardian_error", code: -32000 });
    expect(failureDisposition(refused)).toBe("refusal");

    guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? { error: { code: -32603, message: "internal" } }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    const internal = await acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" }))
      .catch((error: unknown) => error);
    expect(internal).toMatchObject({ kind: "guardian_error", code: -32603 });
    expect(failureDisposition(internal)).toBe("availability");
  });

  it("reads a signed JSON-RPC error carried on a non-2xx response instead of discarding it", async () => {
    guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? { status: 403, error: { code: -32000, message: "refused on 403" } }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    await expect(acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" })))
      .rejects.toMatchObject({ kind: "guardian_error", code: -32000, status: 403, message: "refused on 403" });

    const signedFetch = guardian.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await signedFetch(input, init);
      const value = await response.json() as { error?: { signature?: unknown } };
      if (value.error) delete value.error.signature;
      return Response.json(value, { status: response.status });
    });
    await expect(acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" })))
      .rejects.toMatchObject({ kind: "signature", status: 403 });
  });

  it("rejects a success body on a failure status and keeps the oversize cause on a 5xx", async () => {
    guardian = createGuardian((request) => request.method === "steps/toolCallRequest" ? { status: 502 } : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    const contradictory = await acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" }))
      .catch((caught: unknown) => caught);
    expect(contradictory).toMatchObject({ kind: "invalid_schema", status: 502 });
    expect(failureDisposition(contradictory)).toBe("integrity");

    vi.stubGlobal("fetch", async () => new Response("x".repeat(1_048_577), { status: 503 }));
    const oversized = await acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" }))
      .catch((caught: unknown) => caught);
    expect(oversized).toMatchObject({ kind: "response_too_large", status: 503 });
    expect(failureDisposition(oversized)).toBe("integrity");
  });

  it.each([
    { status: 401, body: "", disposition: "refusal" },
    { status: 403, body: "<html>forbidden</html>", disposition: "refusal" },
    { status: 404, body: '{"error":"not found"}', disposition: "refusal" },
    { status: 429, body: "", disposition: "refusal" },
    { status: 408, body: "", disposition: "availability" },
    { status: 503, body: "unavailable", disposition: "availability" },
  ])("classifies HTTP $status without a JSON-RPC body as $disposition", async ({ status, body, disposition }) => {
    guardian = createGuardian((request) => request.method === "steps/toolCallRequest" ? { status, raw: body } : {});
    vi.stubGlobal("fetch", guardian.fetch);
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    const error = await acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" }))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ kind: "http", status });
    expect(failureDisposition(error)).toBe(disposition);
  });

  it("treats every verification failure as an integrity failure", async () => {
    guardian = createGuardian();
    const signedFetch = guardian.fetch;
    let tamper: "signature" | "key" | "id" | "schema" | "none" = "none";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await signedFetch(input, init);
      const request = JSON.parse(String(init?.body)) as { method?: string };
      if (request.method !== "steps/toolCallRequest" || tamper === "none") return response;
      const value = await response.json();
      if (tamper === "signature") value.result.signature.value = "AAAA";
      if (tamper === "key") value.result.signature.key_id = "other-key";
      if (tamper === "id") value.id = "wrong-id";
      if (tamper === "schema") value.result.decision = "allow-ish";
      return Response.json(value);
    });
    const state = newSessionState();
    const acs = client(guardian.url);
    state.handshake = await acs.handshake(state);
    for (const [kind, expected] of [["signature", "signature"], ["key", "signature"], ["id", "correlation"], ["schema", "invalid_schema"]] as const) {
      tamper = kind;
      const error = await acs.request(state, "steps/toolCallRequest", toolCallPayload("bash", { command: "pwd" }))
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind: expected });
      expect(failureDisposition(error)).toBe("integrity");
    }
    expect(failureDisposition(new TypeError("not an AcsClientError"))).toBe("integrity");
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
