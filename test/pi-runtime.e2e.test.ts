import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AcsRequestEnvelope, JsonObject } from "../src/types.js";
import { createGuardian, TEST_KEY, TEST_KEY_ID } from "./guardian-helper.js";
import { startCaptureGuardian, type CaptureReport } from "./upstream-capture-helper.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const piCli = resolve(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
const acsExtension = resolve(repositoryRoot, "src/index.ts");
const providerExtension = resolve(repositoryRoot, "test/fixtures/e2e-provider.ts");

interface ListeningServer {
  server: Server;
  url: string;
}

interface PiRun {
  events: JsonObject[];
  stderr: string;
}

function commandFrom(request: AcsRequestEnvelope): string | undefined {
  const argument = (request.params.payload.arguments as JsonObject | undefined)?.command;
  if (typeof argument !== "object" || argument === null || Array.isArray(argument)) return undefined;
  const value = (argument as JsonObject).value;
  return typeof value === "string" ? value : undefined;
}

async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(server: Server): Promise<ListeningServer> {
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
}

function completionChunk(delta: JsonObject, finishReason: string | null): string {
  return JSON.stringify({
    id: "chatcmpl-acs-e2e",
    object: "chat.completion.chunk",
    created: 1,
    model: "acs-e2e-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null || Array.isArray(part)) return "";
      const text = (part as JsonObject).text;
      return typeof text === "string" ? text : "";
    })
    .join("");
}

function sendCompletion(response: import("node:http").ServerResponse, command: string | undefined): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  if (command) {
    response.write(`data: ${completionChunk({
      role: "assistant",
      tool_calls: [{
        index: 0,
        id: "call-acs-e2e",
        type: "function",
        function: { name: "bash", arguments: JSON.stringify({ command }) },
      }],
    }, null)}\n\n`);
    response.write(`data: ${completionChunk({}, "tool_calls")}\n\n`);
  } else {
    response.write(`data: ${completionChunk({ role: "assistant", content: "fixture complete" }, null)}\n\n`);
    response.write(`data: ${completionChunk({}, "stop")}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

async function startModelServer(): Promise<ListeningServer> {
  return listen(createServer(async (request, response) => {
    const payload = JSON.parse(await bodyOf(request)) as { messages?: Array<{ role?: string; content?: unknown }> };
    const hasToolResult = payload.messages?.some((message) => message.role === "tool") === true;
    const userMessage = payload.messages?.find((message) => message.role === "user");
    const prompt = messageText(userMessage?.content);
    sendCompletion(response, hasToolResult ? undefined : prompt);
  }));
}

async function runPi(
  directory: string,
  guardianUrl: string,
  modelUrl: string,
  prompt: string,
  enableModify = false,
  startupPosture: "proceed" | "refuse" = "refuse",
  expectCompletion = true,
): Promise<PiRun> {
  const configDirectory = join(directory, "pi-config");
  const sessionDirectory = join(directory, "sessions");
  const configPath = join(directory, "acs.json");
  const auditPath = join(directory, "audit.jsonl");
  await writeFile(configPath, JSON.stringify({
    mode: "enforce",
    startupPosture,
    enableModify,
    guardian: {
      url: `${guardianUrl}/`,
      connectTimeoutMs: 2_000,
      hmacKeyEnv: "PI_ACS_E2E_KEY",
      keyId: TEST_KEY_ID,
    },
    audit: { path: auditPath, includePayloads: false },
  }));

  const child = spawn(process.execPath, [
    piCli,
    "--mode", "json",
    "--no-session",
    "--session-dir", sessionDirectory,
    "--no-extensions",
    "-e", providerExtension,
    "-e", acsExtension,
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--offline",
    "--provider", "acs-e2e",
    "--model", "acs-e2e-model",
    "--tools", "bash",
    prompt,
  ], {
    cwd: directory,
    env: {
      ...process.env,
      PI_ACS_CONFIG: configPath,
      PI_ACS_E2E_KEY: TEST_KEY,
      PI_ACS_E2E_MODEL_URL: `${modelUrl}/v1`,
      PI_CODING_AGENT_DIR: configDirectory,
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Pi timed out. stderr:\n${stderr}`));
    }, 15_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`Pi exited with ${exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }

  const events = stdout
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as JsonObject);
  if (expectCompletion) {
    expect(events.some((event) => event.type === "agent_end")).toBe(true);
    expect(stdout).toContain("fixture complete");
  }
  return { events, stderr };
}

describe("real Pi runtime enforcement", () => {
  let guardianServer: ListeningServer | undefined;
  let modelServer: ListeningServer | undefined;
  const testDirectories = new Set<string>();
  let refuseHandshake = false;
  const guardian = createGuardian((request) => {
    if (request.method === "handshake/hello" && refuseHandshake) {
      return { error: { code: -32000, message: "session refused by end-to-end Guardian" } };
    }
    if (request.method !== "steps/toolCallRequest") return {};
    const command = commandFrom(request);
    if (command?.includes("acs-deny")) {
      return { result: { decision: "deny", reasoning: "blocked by end-to-end Guardian" } };
    }
    if (command?.includes("acs-rewrite")) {
      return {
        result: {
          decision: "modify",
          reasoning: "rewritten by end-to-end Guardian",
          modifications: {
            parameter_overrides: {
              command: command.replace("original", "modified").replace(" # acs-rewrite", ""),
            },
          },
        },
      };
    }
    return {};
  });

  beforeAll(async () => {
    guardianServer = await listen(createServer(async (request, response) => {
      const body = await bodyOf(request);
      const guardianResponse = await guardian.fetch("http://guardian.invalid/", {
        method: "POST",
        body,
      });
      const responseBody = Buffer.from(await guardianResponse.arrayBuffer());
      response.writeHead(guardianResponse.status, Object.fromEntries(guardianResponse.headers.entries()));
      response.end(responseBody);
    }));

    modelServer = await startModelServer();
  });

  afterAll(async () => {
    await Promise.all([
      ...(guardianServer ? [close(guardianServer.server)] : []),
      ...(modelServer ? [close(modelServer.server)] : []),
    ]);
  });

  afterEach(async () => {
    await Promise.all([...testDirectories].map((directory) => rm(directory, { recursive: true, force: true })));
    testDirectories.clear();
  });

  it("allows an actual Bash tool side effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-acs-e2e-allow-"));
    testDirectories.add(directory);
    const target = join(directory, "allowed.txt");
    const result = await runPi(
      directory,
      guardianServer!.url,
      modelServer!.url,
      `printf 'allowed' > ${JSON.stringify(target)}`,
    );
    expect(await readFile(target, "utf8")).toBe("allowed");
    expect(result.events.some((event) => event.type === "tool_execution_end")).toBe(true);
  });

  it("denies an actual Bash tool before its side effect", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-acs-e2e-deny-"));
    testDirectories.add(directory);
    const target = join(directory, "denied.txt");
    const requestOffset = guardian.requests.length;
    await runPi(
      directory,
      guardianServer!.url,
      modelServer!.url,
      `printf 'denied' > ${JSON.stringify(target)} # acs-deny`,
    );
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    expect(guardian.requests.slice(requestOffset).some((request) =>
      request.method === "steps/toolCallRequest" && commandFrom(request)?.includes("acs-deny")
    )).toBe(true);
  });

  it("refuses the session on a signed handshake refusal even with startup proceed, so no Bash side effect occurs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-acs-e2e-refused-"));
    testDirectories.add(directory);
    const target = join(directory, "refused.txt");
    const requestOffset = guardian.requests.length;
    refuseHandshake = true;
    let run: PiRun;
    try {
      // A refused session also blocks the prompt itself at Pi's input event, so the
      // model is never reached and the run ends without an agent_end event.
      run = await runPi(
        directory,
        guardianServer!.url,
        modelServer!.url,
        `printf 'refused' > ${JSON.stringify(target)}`,
        false,
        "proceed",
        false,
      );
    } finally {
      refuseHandshake = false;
    }
    expect(run.events.some((event) => event.type === "agent_end")).toBe(false);
    expect(run.events.some((event) => event.type === "tool_execution_start")).toBe(false);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    const seen = guardian.requests.slice(requestOffset);
    expect(seen.map((request) => request.method)).toEqual(["handshake/hello"]);
    const audit = (await readFile(join(directory, "audit.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as JsonObject);
    expect(audit.some((event) => event.event === "acs_startup_refused" && event.disposition === "refusal" && event.error_code === -32000)).toBe(true);
    expect(audit.some((event) => event.event === "acs_session_unguarded")).toBe(false);
  });

  it("executes the Guardian-modified Bash arguments instead of the model arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-acs-e2e-modify-"));
    testDirectories.add(directory);
    const target = join(directory, "modified.txt");
    await runPi(
      directory,
      guardianServer!.url,
      modelServer!.url,
      `printf 'original' > ${JSON.stringify(target)} # acs-rewrite`,
      true,
    );
    expect(await readFile(target, "utf8")).toBe("modified");
  });
}, 30_000);

// These CLI sessions exercise text input/output and Bash mediation, not every Pi host hook.
describe.skipIf(!process.env.ACS_CAPTURE_PYTHON)("real Pi emissions validated by upstream Python CaptureGuardian", () => {
  let modelServer: ListeningServer;

  beforeAll(async () => {
    modelServer = await startModelServer();
  });

  afterAll(async () => {
    if (modelServer) await close(modelServer.server);
  });

  it.each(["allow", "deny"] as const)("validates the %s session and enforces its Bash decision", async (decision) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-acs-upstream-"));
    try {
      const target = join(directory, "side-effect.txt");
      const command = `printf 'upstream-ok' > ${JSON.stringify(target)}`
        + (decision === "deny" ? " # acs-deny" : "");
      const guardian = await startCaptureGuardian();
      let report: CaptureReport;
      let run: PiRun;
      try {
        run = await runPi(directory, guardian.url, modelServer.url, command);
      } finally {
        // Always reap Python; finish also rejects empty captures and validation/process faults.
        report = await guardian.finish();
      }
      expect(report.errors).toEqual([]);
      expect(report.captures.length).toBeGreaterThan(0);
      for (const capture of report.captures) {
        expect(capture.errors).toEqual([]);
        expect(capture.method).toBe(capture.parsed.method);
      }
      const requests = report.captures.map((capture) => capture.parsed);
      const methods = [
        "steps/sessionStart",
        "steps/userMessage",
        "steps/toolCallRequest",
        ...(decision === "allow" ? ["steps/toolCallResult"] : []),
        "steps/agentResponse",
        "steps/sessionEnd",
      ];
      // Exact ordering also requires one handshake, one complete lifecycle, and no extra calls.
      expect(requests.map((request) => request.method)).toEqual(["handshake/hello", ...methods]);
      const hello = requests[0]!;
      expect(hello.params.payload).toMatchObject({
        acs_versions_supported: ["0.1.0"],
        methods_implemented: expect.arrayContaining(methods),
        transports_supported: ["http", "https"],
        provenance_producer: "none",
        profiles_supported: [],
      });
      const sessionId = hello.params.metadata.session_id;
      expect(sessionId).toEqual(expect.any(String));
      expect(sessionId.length).toBeGreaterThan(0);
      expect(new Set(requests.map((request) => request.id)).size).toBe(requests.length);
      expect(new Set(requests.map((request) => request.params.nonce)).size).toBe(requests.length);
      for (const request of requests) {
        expect(request.id).toBe(request.params.request_id);
        expect(request.id.length).toBeGreaterThan(0);
        expect(request.params.nonce).toEqual(expect.any(String));
        expect(request.params.metadata).toMatchObject({
          agent_id: "pi-coding-agent",
          session_id: sessionId,
          environment: "development",
          platform: "pi",
          platform_version: "0.84.3",
        });
        expect(request.params.signature).toMatchObject({ algorithm: "HMAC-SHA256", key_id: TEST_KEY_ID });
      }
      const payloadFor = (method: string) => requests.find((request) => request.method === method)!.params.payload;
      expect(payloadFor("steps/userMessage")).toMatchObject({ content: [{ type: "text", value: command }] });
      const toolRequest = requests.find((request) => request.method === "steps/toolCallRequest")!;
      expect(commandFrom(toolRequest)).toBe(command);
      expect(toolRequest.params.payload).toMatchObject({ tool: { name: "bash" }, raw_command: command });
      expect(payloadFor("steps/agentResponse")).toMatchObject({
        content: [{ type: "text", value: "fixture complete" }],
      });
      expect(payloadFor("steps/sessionEnd")).toMatchObject({ summary: { decision_failures: {} } });
      const audit = (await readFile(join(directory, "audit.jsonl"), "utf8")).trim().split("\n")
        .map((line) => JSON.parse(line) as JsonObject);
      expect(audit.filter((event) => [
        "acs_startup_refused", "acs_session_unguarded", "acs_decision_failure", "acs_session_end_failure",
      ].includes(String(event.event)))).toEqual([]);
      // These records are emitted only after reply correlation and signature verification.
      for (const request of requests.slice(1)) {
        expect(audit.filter((event) => event.event === "acs_decision" && event.request_id === request.id))
          .toEqual([expect.objectContaining({
            method: request.method,
            session_id: sessionId,
            decision: request.method === "steps/toolCallRequest" ? decision : "allow",
          })]);
      }
      if (decision === "allow") {
        expect(await readFile(target, "utf8")).toBe("upstream-ok");
        expect(run.events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", isError: false }));
        expect(payloadFor("steps/toolCallResult")).toMatchObject({
          tool: { name: "bash" }, request_id_ref: toolRequest.id, exit_status: "success",
        });
      } else {
        await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
        expect(audit).toContainEqual(expect.objectContaining({
          event: "acs_tool_blocked", request_id: toolRequest.id, decision: "deny", tool: "bash",
        }));
        expect(audit.some((event) => event.event === "acs_tool_completed")).toBe(false);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}, 30_000);
