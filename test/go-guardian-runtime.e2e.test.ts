import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { JsonObject } from "../src/types.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const guardianUrl = process.env.ACS_GO_GUARDIAN_URL;
const keyId = "go-interop-key";

function chunk(delta: JsonObject, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-go-interop",
    object: "chat.completion.chunk",
    created: 1,
    model: "acs-e2e-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function signedDecision(audit: JsonObject[], method: string, decision: string): JsonObject {
  const requests = audit.filter((event) => event.event === "acs_request" && event.method === method);
  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.signed).toBe(true);
  const decisions = audit.filter((event) => event.event === "acs_decision"
    && event.method === method && event.request_id === request.request_id
    && event.session_id === request.session_id);
  expect(decisions).toHaveLength(1);
  // acs_decision is emitted only after the client verifies correlation and HMAC.
  expect(decisions[0]).toMatchObject({
    decision,
    payload: {
      request_id: request.request_id,
      decision,
      signature: { algorithm: "HMAC-SHA256", key_id: keyId, value: expect.any(String) },
    },
  });
  if (decision === "deny") {
    expect(decisions[0]!.payload).toMatchObject({ reason_codes: ["destructive_shell_command_blocked"] });
  }
  return request;
}

async function exercise(decision: "allow" | "deny"): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-go-guardian-runtime-"));
  const target = join(directory, "side-effect.txt");
  // The dangerous-looking text is ONLY a shell comment; executing either command is harmless.
  const command = `printf 'interop-ok' > '${target.replaceAll("'", "'\\''")}'`
    + (decision === "deny" ? " # rm -rf /" : "");
  let modelCalls = 0;
  const modelErrors: string[] = [];
  const model = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const part of request) chunks.push(Buffer.from(part));
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        messages?: Array<{ role?: string }>;
      };
      modelCalls++;
      if (modelCalls > 2) throw new Error("unexpected extra model request");
      const hasResult = payload.messages?.some((message) => message.role === "tool");
      if (hasResult !== (modelCalls === 2)) throw new Error("unexpected model conversation");
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      if (!hasResult) {
        response.write(chunk({
          role: "assistant",
          tool_calls: [{
            index: 0,
            id: "call-go-interop",
            type: "function",
            function: { name: "bash", arguments: JSON.stringify({ command }) },
          }],
        }, null));
        response.write(chunk({}, "tool_calls"));
      } else {
        response.write(chunk({ role: "assistant", content: "fixture complete" }, null));
        response.write(chunk({}, "stop"));
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      modelErrors.push(String(error));
      response.writeHead(500).end();
    }
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      model.once("error", reject);
      model.listen(0, "127.0.0.1", resolveListen);
    });
    const address = model.address();
    if (!address || typeof address === "string") throw new Error("model fixture did not bind TCP");
    const configPath = join(directory, "acs.json");
    const auditPath = join(directory, "audit.jsonl");
    await writeFile(configPath, JSON.stringify({
      mode: "enforce",
      startupPosture: "refuse",
      decisionFailurePosture: "deny",
      guardian: {
        url: guardianUrl,
        connectTimeoutMs: 2_000,
        hmacKeyEnv: "PI_ACS_GO_INTEROP_KEY",
        keyId,
      },
      audit: { path: auditPath, includePayloads: true },
    }));
    const child = spawn(process.execPath, [
      resolve(repositoryRoot, "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"),
      "--mode", "json", "--no-session", "--session-dir", join(directory, "sessions"),
      "--no-extensions",
      "-e", resolve(repositoryRoot, "test/fixtures/e2e-provider.ts"),
      "-e", resolve(repositoryRoot, "src/index.ts"),
      "--no-skills", "--no-prompt-templates", "--no-context-files", "--offline",
      "--provider", "acs-e2e", "--model", "acs-e2e-model", "--tools", "bash",
      "Run the local interoperability fixture once.",
    ], {
      cwd: directory,
      env: {
        ...process.env,
        PI_ACS_CONFIG: configPath,
        PI_ACS_E2E_MODEL_URL: `http://127.0.0.1:${address.port}/v1`,
        PI_CODING_AGENT_DIR: join(directory, "pi-config"),
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
    child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 15_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => { clearTimeout(timer); resolveExit(code); });
    });
    if (timedOut || exitCode !== 0) {
      throw new Error(`Pi ${timedOut ? "timed out" : `exited ${exitCode}`}\n${stdout}\n${stderr}`);
    }
    expect(modelErrors).toEqual([]);
    expect(modelCalls).toBe(2);
    const events = stdout.split("\n").filter((line) => line.trim().startsWith("{"))
      .map((line) => JSON.parse(line) as JsonObject);
    expect(events.some((event) => event.type === "agent_end")).toBe(true);
    expect(stdout).toContain("fixture complete");
    const audit = (await readFile(auditPath, "utf8")).trim().split("\n")
      .map((line) => JSON.parse(line) as JsonObject);
    expect(audit.filter((event) => event.event === "acs_request" && event.method === "handshake/hello"))
      .toEqual([expect.objectContaining({ signed: true })]);
    expect(audit.filter((event) => event.event === "acs_startup_refused"
      || event.event === "acs_session_unguarded" || event.event === "acs_decision_failure"
      || event.event === "acs_session_end_failure")).toEqual([]);
    const toolRequest = signedDecision(audit, "steps/toolCallRequest", decision);
    expect(toolRequest.payload).toMatchObject({
      tool: { name: "bash" }, arguments: { command: { value: command } }, raw_command: command,
    });
    if (decision === "allow") {
      expect(await readFile(target, "utf8")).toBe("interop-ok");
      expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", isError: false }));
      const resultRequest = signedDecision(audit, "steps/toolCallResult", "allow");
      expect(resultRequest.payload).toMatchObject({
        tool: { name: "bash" }, request_id_ref: toolRequest.request_id, exit_status: "success",
      });
      expect(audit).toContainEqual(expect.objectContaining({
        event: "acs_tool_completed", request_id: toolRequest.request_id, exit_status: "success",
      }));
    } else {
      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
      expect(audit).toContainEqual(expect.objectContaining({
        event: "acs_tool_blocked", request_id: toolRequest.request_id, tool: "bash", decision: "deny",
      }));
      expect(audit.some((event) => event.event === "acs_tool_completed")).toBe(false);
    }
  } finally {
    await new Promise<void>((resolveClose) => {
      model.close(() => resolveClose());
      model.closeAllConnections();
    });
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!guardianUrl)("real Pi runtime against external Go Guardian", () => {
  beforeAll(() => {
    const endpoint = new URL(guardianUrl!);
    if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:") {
      throw new Error("Run this synthetic-data suite against a loopback HTTP Guardian only");
    }
    if (!process.env.PI_ACS_GO_INTEROP_KEY || Buffer.byteLength(process.env.PI_ACS_GO_INTEROP_KEY) < 32) {
      throw new Error("ACS_GO_GUARDIAN_URL requires PI_ACS_GO_INTEROP_KEY (at least 32 UTF-8 bytes)");
    }
  });

  it("allows an actual harmless Bash file write with signed request/result decisions", async () => {
    await exercise("allow");
  }, 25_000);

  it("denies a harmless Bash command whose comment matches stock policy before writing", async () => {
    await exercise("deny");
  }, 25_000);
});
