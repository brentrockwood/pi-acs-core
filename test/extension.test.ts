import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import acsCoreExtension from "../src/index.js";
import type { AcsRequestEnvelope, JsonObject } from "../src/types.js";
import { createGuardian, TEST_KEY } from "./guardian-helper.js";

type Handler = (event: any, context: ExtensionContext) => Promise<any> | any;

function command(request: AcsRequestEnvelope): string | undefined {
  const argument = (request.params.payload.arguments as JsonObject | undefined)?.command;
  if (typeof argument !== "object" || argument === null || Array.isArray(argument)) return undefined;
  const value = (argument as JsonObject).value;
  return typeof value === "string" ? value : undefined;
}

function fakePi(): { api: ExtensionAPI; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(name: string, handler: Handler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
    registerCommand() {},
    getAllTools() {
      return [{
        name: "bash",
        description: "test bash",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
          additionalProperties: false,
        },
      }];
    },
  } as unknown as ExtensionAPI;
  return { api, handlers };
}

async function oneHandler(handlers: Map<string, Handler[]>, name: string, event: unknown, context: ExtensionContext) {
  const handler = handlers.get(name)?.[0];
  if (!handler) throw new Error(`missing ${name} handler`);
  return handler(event, context);
}

describe("Pi extension enforcement", () => {
  let directory: string;
  let auditPath: string;
  let configPath: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "pi-acs-core-test-"));
    auditPath = join(directory, "audit.jsonl");
    configPath = join(directory, "config.json");
    process.env.PI_ACS_CONFIG = configPath;
    process.env.PI_ACS_TEST_KEY = TEST_KEY;
  });

  afterEach(() => {
    delete process.env.PI_ACS_CONFIG;
    delete process.env.PI_ACS_TEST_KEY;
    vi.unstubAllGlobals();
  });

  async function configure(
    url: string,
    mode: "observe" | "enforce" = "enforce",
    enableModify = false,
    startupPosture: "proceed" | "refuse" = "refuse",
    decisionFailurePosture?: "proceed" | "deny",
  ): Promise<void> {
    await writeFile(configPath, JSON.stringify({
      mode,
      startupPosture,
      ...(decisionFailurePosture ? { decisionFailurePosture } : {}),
      enableModify,
      guardian: { url, hmacKeyEnv: "PI_ACS_TEST_KEY", keyId: "test-key" },
      audit: { path: auditPath, includePayloads: false },
    }));
  }

  function context(confirm = vi.fn(async () => false)): ExtensionContext {
    return {
      ui: {
        notify: vi.fn(),
        setStatus: vi.fn(),
        confirm,
      },
    } as unknown as ExtensionContext;
  }

  it.each([
    { posture: "deny" as const, local: "deny" as const, fails: false, blocked: false },
    { posture: "proceed" as const, local: "proceed" as const, fails: true, blocked: false },
    { posture: "proceed" as const, local: "deny" as const, fails: true, blocked: true },
    { posture: "deny" as const, local: "proceed" as const, fails: true, blocked: true },
    { posture: "deny" as const, local: "deny" as const, fails: true, blocked: true },
  ])("preserves enforcement with an unwritable audit file, with the Guardian only able to tighten the local posture: %j", async ({ posture, local, fails, blocked }) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const guardian = createGuardian((request) => request.method === "handshake/hello"
      ? { onDecisionFailure: posture }
      : fails && request.method === "steps/toolCallRequest" ? { error: { code: -32603, message: "internal" } } : {});
    vi.stubGlobal("fetch", guardian.fetch);
    auditPath = directory;
    await configure(guardian.url, "enforce", false, "refuse", local);
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const result = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "probe", toolName: "bash", input: { command: "pwd" },
    }, ctx);
    expect(result.block === true).toBe(blocked);
    const failures = stderr.mock.calls.map(([line]) => JSON.parse(String(line))).filter((record) => record.event === "acs_decision_failure");
    expect(failures).toHaveLength(fails ? 1 : 0);
    await oneHandler(handlers, "session_shutdown", { reason: "quit" }, ctx);
    expect(guardian.requests.at(-1)?.params.payload.summary).toEqual({ decision_failures: fails ? { guardian_error: 1 } : {} });
    stderr.mockRestore();
  });

  it("reports decision failure counts at shutdown and resets them for a new session", async () => {
    const guardian = createGuardian((request) => request.method === "steps/toolCallRequest" ? { raw: "{" } : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url);
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "failed", toolName: "bash", input: { command: "pwd" },
    }, ctx);
    await oneHandler(handlers, "session_shutdown", { reason: "quit" }, ctx);
    expect(guardian.requests.find((request) => request.method === "steps/sessionEnd")?.params.payload.summary)
      .toEqual({ decision_failures: { malformed_response: 1 } });
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "new" }, ctx);
    await oneHandler(handlers, "session_shutdown", { reason: "quit" }, ctx);
    expect(guardian.requests.filter((request) => request.method === "steps/sessionEnd").at(-1)?.params.payload.summary)
      .toEqual({ decision_failures: {} });
  });

  it("blocks deny, validates modify, and correlates parallel tool results", async () => {
    const guardian = createGuardian((request) => {
      if (request.method !== "steps/toolCallRequest") return {};
      const value = command(request);
      if (value === "deny") return { result: { decision: "deny", reasoning: "blocked in test" } };
      if (value === "rewrite") {
        return {
          result: {
            decision: "modify",
            reasoning: "rewritten in test",
            modifications: { parameter_overrides: { command: "rewritten" } },
          },
        };
      }
      return {};
    });
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url, "enforce", true);
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    const deniedInput = { command: "deny" };
    const denied = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "denied", toolName: "bash", input: deniedInput,
    }, ctx);
    expect(denied).toMatchObject({ block: true, reason: "blocked in test" });
    expect(deniedInput.command).toBe("deny");

    const rewrittenInput = { command: "rewrite" };
    const [rewritten, allowed] = await Promise.all([
      oneHandler(handlers, "tool_call", {
        type: "tool_call", toolCallId: "first", toolName: "bash", input: rewrittenInput,
      }, ctx),
      oneHandler(handlers, "tool_call", {
        type: "tool_call", toolCallId: "second", toolName: "bash", input: { command: "allow" },
      }, ctx),
    ]);
    expect(rewritten).toEqual({});
    expect(allowed).toEqual({});
    expect(rewrittenInput.command).toBe("rewritten");

    await Promise.all([
      oneHandler(handlers, "tool_result", {
        type: "tool_result", toolCallId: "first", toolName: "bash", input: rewrittenInput,
        content: [{ type: "text", text: "first result" }], isError: false,
      }, ctx),
      oneHandler(handlers, "tool_result", {
        type: "tool_result", toolCallId: "second", toolName: "bash", input: { command: "allow" },
        content: [{ type: "text", text: "second result" }], isError: false,
      }, ctx),
    ]);

    const calls = guardian.requests.filter((request) => request.method === "steps/toolCallRequest");
    const results = guardian.requests.filter((request) => request.method === "steps/toolCallResult");
    const callIds = new Set(calls.map((request) => request.params.request_id));
    expect(results).toHaveLength(2);
    expect(results.every((request) => callIds.has(String(request.params.payload.request_id_ref)))).toBe(true);

    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"payload":"[omitted]"');
    expect(audit).not.toContain("first result");
    expect(audit).toContain('"adapter_version":"0.1.0-alpha.1"');
    expect(audit).toContain('"pi_version":"0.84.3"');
    expect(audit).toContain('"call_id":"first"');
  });

  it("does not send unevaluated methods or create dangling result correlation", async () => {
    const guardian = createGuardian((request) => {
      if (request.method === "handshake/hello") {
        return { methodsEvaluated: ["steps/sessionStart", "steps/toolCallResult"] };
      }
      if (request.method === "steps/toolCallRequest") {
        return { error: { code: -32601, message: "method not evaluated" } };
      }
      return {};
    });
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url);
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    await expect(oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "unevaluated", toolName: "bash", input: { command: "allowed" },
    }, ctx)).resolves.toEqual({});
    await oneHandler(handlers, "tool_result", {
      type: "tool_result", toolCallId: "unevaluated", toolName: "bash", input: { command: "allowed" },
      content: [{ type: "text", text: "result" }], isError: false,
    }, ctx);

    expect(guardian.requests.some((request) => request.method === "steps/toolCallRequest")).toBe(false);
    const result = guardian.requests.find((request) => request.method === "steps/toolCallResult");
    expect(result).toBeDefined();
    expect(result?.params.payload.request_id_ref).toBeUndefined();
    const audit = await readFile(auditPath, "utf8");
    expect(audit).toContain('"event":"acs_unevaluated_allow"');
    expect(audit).toContain('"method":"steps/toolCallRequest"');
  });

  it("blocks MODIFY unless it is explicitly enabled", async () => {
    const guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? {
          result: {
            decision: "modify",
            reasoning: "test disabled modification",
            modifications: { parameter_overrides: { command: "rewritten" } },
          },
        }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url);
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const input = { command: "original" };
    const result = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input,
    }, ctx);
    expect(result).toMatchObject({ block: true, reason: expect.stringContaining("disabled") });
    expect(input.command).toBe("original");
  });

  it("fails closed on a malformed Guardian decision", async () => {
    const guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? { raw: "{malformed" }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url);
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const result = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input: { command: "anything" },
    }, ctx);
    expect(result).toMatchObject({ block: true });
    expect(result.reason).toContain("invalid JSON");
  });

  it("routes a human ASK through Pi confirmation", async () => {
    const guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? {
          result: {
            decision: "ask",
            reasoning: "human approval required",
            ask_details: {
              approver: { type: "human", id: "operator" },
              question: "Run this command?",
              timeout_seconds: 5,
            },
          },
        }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url);
    const { api, handlers } = fakePi();
    const confirm = vi.fn(async () => true);
    const ctx = context(confirm);
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const result = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input: { command: "anything" },
    }, ctx);
    expect(result).toEqual({});
    expect(confirm).toHaveBeenCalledWith("ACS approval: operator", "Run this command?", expect.any(Object));
  });

  it("gates tool results and finalized assistant content", async () => {
    const guardian = createGuardian((request) => {
      if (request.method === "steps/toolCallResult") {
        return { result: { decision: "deny", reasoning: "result contains restricted output" } };
      }
      if (request.method === "steps/agentResponse") {
        return {
          result: {
            decision: "modify",
            reasoning: "replace final answer",
            modifications: { modified_content: "approved response" },
          },
        };
      }
      return {};
    });
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url, "enforce", true);
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input: { command: "allowed" },
    }, ctx);
    const toolResult = await oneHandler(handlers, "tool_result", {
      type: "tool_result", toolCallId: "one", toolName: "bash", input: { command: "allowed" },
      content: [{ type: "text", text: "secret" }], isError: false,
    }, ctx);
    expect(toolResult).toMatchObject({ isError: true });
    expect(toolResult.content[0].text).toContain("restricted output");

    const message = {
      role: "assistant",
      content: [{ type: "text", text: "original" }],
      api: "test", provider: "test", model: "test", stopReason: "stop", timestamp: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const response = await oneHandler(handlers, "message_end", { type: "message_end", message }, ctx);
    expect(response.message.content).toEqual([{ type: "text", text: "approved response" }]);
  });

  it("refuses mediated actions after a failed closed startup handshake", async () => {
    const guardian = createGuardian((request) => request.method === "handshake/hello"
      ? { raw: "{broken" }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url);
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const result = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input: { command: "anything" },
    }, ctx);
    expect(result).toMatchObject({ block: true });
    expect(guardian.requests).toHaveLength(1);
  });

  it.each([
    { name: "a signed SESSION_REFUSED error", reply: { error: { code: -32000, message: "session refused by policy" } }, disposition: "refusal", code: -32000 },
    { name: "a signed UNSUPPORTED_VERSION error", reply: { error: { code: -32001, message: "no common version" } }, disposition: "refusal", code: -32001 },
    { name: "an HTTP 401 without a body", reply: { status: 401, raw: "" }, disposition: "refusal" },
    { name: "an unverifiable ServerHello", reply: { unsignedHello: true }, disposition: "integrity" },
    { name: "malformed handshake JSON", reply: { raw: "{broken" }, disposition: "integrity" },
  ])("refuses the whole session on $name even when startup posture is proceed", async ({ reply, disposition, code }) => {
    const guardian = createGuardian((request) => request.method === "handshake/hello" ? reply : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url, "enforce", false, "proceed");
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("acs-core", "ACS refused");

    const tool = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input: { command: "anything" },
    }, ctx);
    expect(tool).toMatchObject({ block: true });
    const input = await oneHandler(handlers, "input", { type: "input", text: "hello" }, ctx);
    expect(input).toEqual({ action: "handled" });
    expect(guardian.requests.filter((request) => request.method !== "handshake/hello")).toHaveLength(0);

    const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const refused = audit.filter((record) => record.event === "acs_startup_refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ disposition, ...(code ? { error_code: code } : {}) });
    expect(audit.some((record) => record.event === "acs_session_unguarded")).toBe(false);
  });

  it.each([
    { name: "a refused connection", reply: undefined, failureKind: "transport" },
    { name: "an HTTP 503 without a body", reply: { status: 503, raw: "unavailable" }, failureKind: "http" },
    { name: "a signed internal error", reply: { error: { code: -32603, message: "internal" } }, failureKind: "guardian_error" },
  ])("starts unguarded on $name only because startup posture is proceed", async ({ reply, failureKind }) => {
    const guardian = createGuardian((request) => request.method === "handshake/hello" && reply ? reply : {});
    vi.stubGlobal("fetch", reply ? guardian.fetch : async () => { throw new TypeError("connect ECONNREFUSED"); });
    await configure(guardian.url, "enforce", false, "proceed");
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    expect(ctx.ui.setStatus).toHaveBeenCalledWith("acs-core", "ACS unguarded");
    const tool = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input: { command: "anything" },
    }, ctx);
    expect(tool).toEqual({});
    const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.filter((record) => record.event === "acs_session_unguarded")).toEqual([
      expect.objectContaining({ disposition: "availability", failure_kind: failureKind }),
    ]);
    expect(audit.some((record) => record.event === "acs_startup_refused")).toBe(false);
  });

  it("still follows refuse for an outage at startup", async () => {
    vi.stubGlobal("fetch", async () => { throw new TypeError("connect ECONNREFUSED"); });
    await configure("http://127.0.0.1:1/", "enforce", false, "refuse");
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const tool = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input: { command: "anything" },
    }, ctx);
    expect(tool).toMatchObject({ block: true, reason: expect.stringContaining("startup posture is refuse") });
  });

  it("blocks refusals and integrity failures under a negotiated proceed posture, and fails open only on outages", async () => {
    let failure = "none";
    const guardian = createGuardian((request) => {
      if (request.method === "handshake/hello") return { onDecisionFailure: "proceed" };
      if (request.method !== "steps/toolCallRequest") return {};
      switch (failure) {
        case "refused": return { error: { code: -32000, message: "refused" } };
        case "refused-on-403": return { status: 403, error: { code: -32000, message: "refused" } };
        case "http-403": return { status: 403, raw: "" };
        case "malformed": return { raw: "{" };
        case "internal": return { error: { code: -32603, message: "internal" } };
        case "http-503": return { status: 503, raw: "unavailable" };
        case "timeout": return { delayMs: 200 };
        default: return {};
      }
    });
    const signedFetch = guardian.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failure === "offline") throw new TypeError("offline");
      const response = await signedFetch(input, init);
      const request = JSON.parse(String(init?.body)) as { method?: string };
      if (request.method !== "steps/toolCallRequest") return response;
      if (!["signature", "key", "id", "request_id", "allow-shape"].includes(failure)) return response;
      const value = await response.json();
      if (failure === "signature") value.result.signature.value = "AAAA";
      if (failure === "key") value.result.signature.key_id = "other-key";
      if (failure === "id") value.id = "wrong-id";
      if (failure === "request_id") value.result.request_id = "00000000-0000-4000-8000-000000000000";
      if (failure === "allow-shape") value.result.decision = "allowed";
      return Response.json(value);
    });
    await configure(guardian.url, "enforce", false, "proceed");
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

    const blocking = ["refused", "refused-on-403", "http-403", "malformed", "signature", "key", "id", "request_id", "allow-shape"];
    const open = ["internal", "http-503", "timeout", "offline"];
    for (const kind of [...blocking, ...open]) {
      failure = kind;
      const result = await oneHandler(handlers, "tool_call", {
        type: "tool_call", toolCallId: kind, toolName: "bash", input: { command: kind },
      }, ctx);
      if (blocking.includes(kind)) expect(result, kind).toMatchObject({ block: true });
      else expect(result, kind).toEqual({});
    }
    failure = "none";
    await oneHandler(handlers, "session_shutdown", { reason: "quit" }, ctx);

    const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    const failures = audit.filter((record) => record.event === "acs_decision_failure");
    expect(failures).toHaveLength(blocking.length + open.length);
    expect(failures.every((record) => record.posture === "proceed" && typeof record.disposition === "string")).toBe(true);
    expect(failures.filter((record) => record.disposition === "availability")).toHaveLength(open.length);
    expect(audit.filter((record) => record.event === "acs_fail_open")).toHaveLength(open.length);
    expect(audit.filter((record) => record.event === "acs_tool_blocked")).toHaveLength(blocking.length);
    const summary = guardian.requests.at(-1)?.params.payload.summary as { decision_failures: Record<string, number> };
    expect(Object.values(summary.decision_failures).reduce((total, count) => total + count, 0)).toBe(blocking.length + open.length);
  });

  it("never blocks on a refusal in observe mode", async () => {
    const guardian = createGuardian((request) => request.method === "handshake/hello"
      ? { error: { code: -32000, message: "session refused by policy" } }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url, "observe", false, "proceed");
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const result = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input: { command: "anything" },
    }, ctx);
    expect(result).toEqual({});
    const audit = (await readFile(auditPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(audit.filter((record) => record.event === "acs_session_unguarded")).toEqual([
      expect.objectContaining({ disposition: "refusal", error_code: -32000 }),
    ]);
  });

  it("does not apply Guardian decisions in observe mode", async () => {
    const guardian = createGuardian((request) => request.method === "steps/toolCallRequest"
      ? { result: { decision: "deny", reasoning: "would block in enforce mode" } }
      : {});
    vi.stubGlobal("fetch", guardian.fetch);
    await configure(guardian.url, "observe");
    const { api, handlers } = fakePi();
    const ctx = context();
    acsCoreExtension(api);
    await oneHandler(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const result = await oneHandler(handlers, "tool_call", {
      type: "tool_call", toolCallId: "one", toolName: "bash", input: { command: "anything" },
    }, ctx);
    expect(result).toEqual({});
  });
});
