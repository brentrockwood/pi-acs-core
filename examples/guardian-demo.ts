import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { deriveSessionKey, signEnvelope, verifyEnvelope } from "../src/crypto.js";
import { METHODS_IMPLEMENTED } from "../src/mapper.js";
import { validateRequest, validateResponse } from "../src/schema.js";
import type { AcsRequestEnvelope, AcsResponseEnvelope, AcsResult, JsonObject } from "../src/types.js";
import { ACS_VERSION } from "../src/types.js";

const host = "127.0.0.1";
const port = Number(process.env.PI_ACS_DEMO_PORT ?? "8787");
const inputKeyMaterial = process.env.PI_ACS_DEMO_KEY;
const keyId = "pi-acs-demo";

if (!inputKeyMaterial) {
  throw new Error("Set PI_ACS_DEMO_KEY to a local test value before starting the demo Guardian");
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 1_048_576) throw new Error("request too large");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toolCommand(payload: JsonObject): string | undefined {
  const argument = (payload.arguments as JsonObject | undefined)?.command;
  if (typeof argument !== "object" || argument === null || Array.isArray(argument)) return undefined;
  const value = (argument as JsonObject).value;
  return typeof value === "string" ? value : undefined;
}

function decisionFor(request: AcsRequestEnvelope): Omit<AcsResult, "type" | "acs_version" | "request_id"> {
  if (request.method === "handshake/hello") {
    const offered = request.params.payload.methods_implemented;
    const methods = Array.isArray(offered)
      ? offered.filter((method): method is string => typeof method === "string" && METHODS_IMPLEMENTED.includes(method as never))
      : [];
    return {
      decision: "allow",
      payload: {
        negotiated_version: ACS_VERSION,
        methods_evaluated: methods,
        selected_transport: "http",
        signature_algorithms_supported: ["HMAC-SHA256"],
        timeout_config: { default_ms: 2_000 },
        on_decision_failure: "deny",
        policy_requires_provenance: false,
        profiles_accepted: [],
      },
    };
  }
  if (request.method === "system/ping") {
    return {
      decision: "allow",
      payload: {
        status: "ok",
        ...(typeof request.params.payload.echo === "string" ? { echo: request.params.payload.echo } : {}),
        server_timestamp: new Date().toISOString(),
      },
    };
  }
  if (request.method === "steps/toolCallRequest") {
    const command = toolCommand(request.params.payload);
    if (command?.includes("acs-deny")) {
      return { decision: "deny", reasoning: "Demo rule blocked a command containing acs-deny" };
    }
    if (command?.includes("acs-rewrite")) {
      return {
        decision: "modify",
        reasoning: "Demo rule replaced the command",
        modifications: { parameter_overrides: { command: "printf 'rewritten by ACS demo guardian\\n'" } },
      };
    }
  }
  return { decision: "allow" };
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    if (incoming.method !== "POST" || incoming.url !== "/") {
      sendJson(outgoing, 404, { error: "not found" });
      return;
    }
    const request = JSON.parse(await requestBody(incoming)) as AcsRequestEnvelope;
    validateRequest(request);
    const sessionKey = deriveSessionKey(inputKeyMaterial, request.params.metadata.session_id);
    if (request.method !== "system/ping") {
      const signature = request.params.signature;
      if (!signature || signature.key_id !== keyId || !verifyEnvelope(request, sessionKey, signature)) {
        sendJson(outgoing, 401, { error: "invalid signature" });
        return;
      }
    }

    const command = request.method === "steps/toolCallRequest" ? toolCommand(request.params.payload) : undefined;
    if (command?.includes("acs-malformed")) {
      outgoing.writeHead(200, { "content-type": "application/json" });
      outgoing.end("{not-json");
      return;
    }
    if (command?.includes("acs-delay")) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000));
    }

    const result = {
      type: "final",
      acs_version: ACS_VERSION,
      request_id: request.params.request_id,
      ...decisionFor(request),
    } as AcsResult;
    const response: AcsResponseEnvelope = { jsonrpc: "2.0", id: request.id, result };
    if (request.method !== "system/ping") result.signature = signEnvelope(response, sessionKey, keyId);
    validateResponse(response);
    sendJson(outgoing, 200, response);
  } catch (error) {
    sendJson(outgoing, 400, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  process.stdout.write(`Demo ACS Guardian listening on http://${host}:${port}/\n`);
});
