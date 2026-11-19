import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AcsRequestEnvelope } from "../src/types.js";
import { TEST_KEY, TEST_KEY_ID } from "./guardian-helper.js";

export interface CaptureReport {
  captures: Array<{ method: string; parsed: AcsRequestEnvelope; errors: string[] }>;
  errors: string[];
}

export async function startCaptureGuardian(): Promise<{ url: string; finish(): Promise<CaptureReport> }> {
  const python = process.env.ACS_CAPTURE_PYTHON;
  if (!python) throw new Error("ACS_CAPTURE_PYTHON must name Python with the pinned upstream adapters installed");
  const env: NodeJS.ProcessEnv = { ...process.env, ACS_CAPTURE_SECRET: TEST_KEY, ACS_CAPTURE_KEY_ID: TEST_KEY_ID };
  delete env.ACS_SPEC_DIR;
  const child = spawn(python, ["-I", fileURLToPath(new URL("./fixtures/upstream-capture.py", import.meta.url))], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let spawnError: Error | undefined;
  child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
  child.on("error", (error) => { spawnError = error; });
  const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`CaptureGuardian startup timed out: ${stderr}`));
      }, 10_000);
      const onData = () => {
        if (!stdout.includes("\n")) return;
        child.stdout.off("data", onData);
        clearTimeout(timer);
        try {
          const ready = JSON.parse(stdout.split("\n")[0]!) as { url: string };
          const endpoint = new URL(ready.url);
          if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:") throw new Error("capture endpoint must be loopback HTTP");
          resolve(ready.url);
        } catch (error) { reject(error); }
      };
      child.stdout.on("data", onData);
      void exited.then((code) => {
        clearTimeout(timer);
        reject(new Error(`CaptureGuardian exited before readiness (${code}): ${spawnError?.message ?? stderr}`));
      });
    });
  } catch (error) {
    child.kill("SIGKILL");
    await exited;
    throw error;
  }

  let finished: Promise<CaptureReport> | undefined;
  return {
    url,
    finish() {
      finished ??= (async () => {
        // EOF asks the bridge to stop serving before it validates and reports.
        child.stdin.end();
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        try {
          const code = await exited;
          const lines = stdout.trim().split("\n");
          if (code !== 0 || lines.length !== 2) {
            throw new Error(`CaptureGuardian validation/process failure (${code}): ${stderr}\n${lines.at(-1) ?? "no report"}`);
          }
          const report = JSON.parse(lines[1]!) as CaptureReport;
          if (!report.captures.length || report.errors.length || report.captures.some((record) => record.errors.length)) {
            throw new Error(`CaptureGuardian invalid capture: ${JSON.stringify(report)}`);
          }
          return report;
        } finally { clearTimeout(timer); }
      })();
      return finished;
    },
  };
}
