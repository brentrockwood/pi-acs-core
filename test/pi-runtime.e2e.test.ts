import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AcsRequestEnvelope, JsonObject } from "../src/types.js";
import { createGuardian, TEST_KEY, TEST_KEY_ID } from "./guardian-helper.js";

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

async function runPi(
  directory: string,
  guardianUrl: string,
  modelUrl: string,
  prompt: string,
  enableModify = false,
): Promise<PiRun> {
  const configDirectory = join(directory, "pi-config");
  const sessionDirectory = join(directory, "sessions");
  const configPath = join(directory, "acs.json");
  const auditPath = join(directory, "audit.jsonl");
  await writeFile(configPath, JSON.stringify({
    mode: "enforce",
    startupPosture: "refuse",
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
  expect(events.some((event) => event.type === "agent_end")).toBe(true);
  expect(stdout).toContain("fixture complete");
  return { events, stderr };
}

describe("real Pi runtime enforcement", () => {
  let guardianServer: ListeningServer | undefined;
  let modelServer: ListeningServer | undefined;
  const testDirectories = new Set<string>();
  const guardian = createGuardian((request) => {
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

    modelServer = await listen(createServer(async (request, response) => {
      const payload = JSON.parse(await bodyOf(request)) as { messages?: Array<{ role?: string; content?: unknown }> };
      const hasToolResult = payload.messages?.some((message) => message.role === "tool") === true;
      const userMessage = payload.messages?.find((message) => message.role === "user");
      const prompt = messageText(userMessage?.content);
      sendCompletion(response, hasToolResult ? undefined : prompt);
    }));
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
