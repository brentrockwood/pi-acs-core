import { randomBytes, randomUUID } from "node:crypto";
import type { AcsConfig } from "./config.js";
import type { AcsRequestEnvelope, JsonObject, JsonValue, SessionState } from "./types.js";
import { ACS_VERSION } from "./types.js";

export const METHODS_IMPLEMENTED = [
  "steps/sessionStart",
  "steps/sessionEnd",
  "steps/userMessage",
  "steps/agentResponse",
  "steps/toolCallRequest",
  "steps/toolCallResult",
  "system/ping",
] as const;

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function newSessionState(): SessionState {
  return { sessionId: randomUUID(), guarded: false, refuseActions: false };
}

export function buildRequest(
  config: AcsConfig,
  state: SessionState,
  method: string,
  payload: JsonObject,
): AcsRequestEnvelope {
  const requestId = randomUUID();
  return {
    jsonrpc: "2.0",
    method,
    id: requestId,
    params: {
      acs_version: ACS_VERSION,
      request_id: requestId,
      timestamp: new Date().toISOString(),
      nonce: randomBytes(16).toString("hex"),
      metadata: {
        agent_id: config.agent.id,
        ...(config.agent.name ? { agent_name: config.agent.name } : {}),
        session_id: state.sessionId,
        ...(state.turnId ? { turn_id: state.turnId } : {}),
        ...(state.chainHash ? { session_state: { chain_hash: state.chainHash } } : {}),
        environment: config.agent.environment,
        platform: "pi",
        platform_version: "0.84.x",
      },
      payload,
    },
  };
}

export function clientHello(): JsonObject {
  return {
    acs_versions_supported: [ACS_VERSION],
    methods_implemented: [...METHODS_IMPLEMENTED],
    transports_supported: ["http", "https"],
    max_payload_size_bytes: 1_048_576,
    provenance_producer: "none",
    wrapped_protocols: [],
    // This alpha deliberately makes no conformance claim. It implements the
    // minimum Instrument hooks, but not every ACS-Core requirement yet.
    profiles_supported: [],
  };
}

export function toolCallPayload(toolName: string, input: Record<string, unknown>): JsonObject {
  const argumentsObject: JsonObject = {};
  for (const [name, value] of Object.entries(input)) argumentsObject[name] = { value: jsonValue(value) };
  return {
    tool: { name: toolName },
    arguments: argumentsObject,
    ...(typeof input.command === "string" ? { raw_command: input.command } : {}),
  };
}

export function toolResultPayload(
  toolName: string,
  requestId: string | undefined,
  content: unknown[],
  isError: boolean,
): JsonObject {
  return {
    tool: { name: toolName },
    ...(requestId ? { request_id_ref: requestId } : {}),
    exit_status: isError ? "failure" : "success",
    outputs: content.map((value) => ({ value: jsonValue(value) })),
  };
}

export function contentPayload(content: unknown): JsonObject {
  const items = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
  return {
    content: items.map((item) => {
      if (typeof item === "object" && item !== null && "type" in item) {
        const typed = item as Record<string, unknown>;
        return { type: typed.type === "image" ? "image" : "text", value: jsonValue(typed.text ?? typed.data ?? typed) };
      }
      return { type: "text", value: jsonValue(item) };
    }),
  };
}

export function observableContentPayload(content: unknown): JsonObject | undefined {
  const rawItems = Array.isArray(content) ? content : [{ type: "text", text: String(content) }];
  const items = rawItems.flatMap((item): JsonObject[] => {
    if (typeof item !== "object" || item === null || !("type" in item)) {
      return [{ type: "text", value: jsonValue(item) }];
    }
    const typed = item as Record<string, unknown>;
    if (typed.type === "text" && typeof typed.text === "string") {
      return [{ type: "text", value: typed.text }];
    }
    if (typed.type === "image" && typeof typed.data === "string") {
      return [{
        type: "image",
        value: {
          data: typed.data,
          ...(typeof typed.mimeType === "string" ? { mime_type: typed.mimeType } : {}),
        },
      }];
    }
    // Pi assistant messages also contain private reasoning and tool-call
    // records. Neither is a user-visible agentResponse content item.
    return [];
  });
  return items.length > 0 ? { content: items } : undefined;
}
