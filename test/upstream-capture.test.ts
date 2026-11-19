import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveSessionKey, signEnvelope } from "../src/crypto.js";
import type { AcsRequestEnvelope } from "../src/types.js";
import { TEST_KEY, TEST_KEY_ID } from "./guardian-helper.js";
import { startCaptureGuardian } from "./upstream-capture-helper.js";

describe.skipIf(!process.env.ACS_CAPTURE_PYTHON)("upstream capture bridge controls", () => {
  it("fails rather than passing an empty capture", async () => {
    const guardian = await startCaptureGuardian();
    await expect(guardian.finish()).rejects.toThrow("no requests captured");
  });

  it.each(["valid", "bad signature", "bad payload"] as const)("checks %s traffic with the upstream oracle", async (kind) => {
    const guardian = await startCaptureGuardian();
    try {
      const sessionId = randomUUID();
      const requestId = randomUUID();
      const request: AcsRequestEnvelope = {
        jsonrpc: "2.0", id: requestId, method: "steps/toolCallRequest",
        params: {
          acs_version: "0.1.0", request_id: requestId, nonce: randomUUID(), timestamp: new Date().toISOString(),
          metadata: { agent_id: "capture-control", session_id: sessionId, platform: "test", platform_version: "0" },
          payload: { tool: { name: "shell" }, arguments: { command: { value: "echo synthetic" } } },
        },
      };
      if (kind === "bad payload") request.params.payload.arguments = { command: "missing value wrapper" };
      request.params.signature = signEnvelope(request, deriveSessionKey(TEST_KEY, sessionId), TEST_KEY_ID);
      if (kind === "bad signature") request.params.signature.value = Buffer.alloc(32).toString("base64");
      const response = await fetch(guardian.url, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request),
        signal: AbortSignal.timeout(5_000), redirect: "error",
      });
      await response.arrayBuffer();
      if (kind === "valid") {
        const report = await guardian.finish();
        expect(report.errors).toEqual([]);
        expect(report.captures).toEqual([{ method: request.method, parsed: request, errors: [] }]);
      } else {
        await expect(guardian.finish()).rejects.toThrow(kind === "bad signature" ? "signature does not independently verify" : "payload(tool-call-request.json)");
      }
    } finally {
      // finish is idempotent; a deliberately rejected capture has already been asserted above.
      await guardian.finish().catch(() => undefined);
    }
  });
});
