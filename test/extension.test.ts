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
  ): Promise<void> {
    await writeFile(configPath, JSON.stringify({
      mode,
      startupPosture: "refuse",
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
