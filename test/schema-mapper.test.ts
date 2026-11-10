import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { buildRequest, clientHello, newSessionState, observableContentPayload, toolCallPayload } from "../src/mapper.js";
import { validateRequest, validateResponse } from "../src/schema.js";

const config = parseConfig({ guardian: { url: "http://127.0.0.1:8787" } }, "/work");

describe("vendored ACS schemas and mappers", () => {
  it("validates a generated canonical request offline", () => {
    const request = buildRequest(config, newSessionState(), "steps/toolCallRequest", toolCallPayload("bash", {
      command: "pwd",
      timeout: 10,
    }));
    expect(() => validateRequest(request)).not.toThrow();
    expect(request.params.payload.arguments).toEqual({
      command: { value: "pwd" },
      timeout: { value: 10 },
    });
  });

  it("rejects malformed envelopes", () => {
    expect(() => validateResponse({ jsonrpc: "2.0", id: "not-enough" })).toThrow("invalid ACS response envelope");
  });

  it("does not advertise a conformance profile this alpha has not earned", () => {
    expect(clientHello().profiles_supported).toEqual([]);
  });

  it("omits Pi reasoning and tool calls from user-visible agent response content", () => {
    expect(observableContentPayload([
      { type: "thinking", thinking: "private" },
      { type: "toolCall", id: "1", name: "read", arguments: {} },
      { type: "text", text: "answer" },
    ])).toEqual({ content: [{ type: "text", value: "answer" }] });
  });
});


describe("refreshed ACS schema constraints", () => {
  it.each([undefined, "tool-output", ""])("validates provenance source_id %j", (sourceId) => {
    const request = buildRequest(config, newSessionState(), "steps/toolCallRequest", {
      tool: { name: "bash" },
      arguments: {
        command: {
          value: "pwd",
          provenance: {
            provenance_id: "source-1",
            origin: "tool_output",
            ...(sourceId === undefined ? {} : { source_id: sourceId }),
          },
        },
      },
    });
    if (sourceId === "") {
      expect(() => validateRequest(request)).toThrow(/source_id.*fewer than 1 characters/);
    } else {
      expect(() => validateRequest(request)).not.toThrow();
    }
  });

  it.each(["policy_id", "policy_version", "policy_name", "rule_id"])(
    "requires nonempty %s only when present",
    (field) => {
      for (const value of [undefined, "policy-1", ""]) {
        const response = {
          jsonrpc: "2.0" as const,
          id: "decision-1",
          result: {
            type: "final" as const,
            acs_version: "0.1.0",
            request_id: "00000000-0000-4000-8000-000000000001",
            decision: "allow" as const,
            policy_references: [value === undefined ? {} : { [field]: value }],
          },
        };
        if (value === "") {
          expect(() => validateResponse(response)).toThrow(new RegExp(`${field}.*fewer than 1 characters`));
        } else {
          expect(() => validateResponse(response)).not.toThrow();
        }
      }
    },
  );

  const failureClasses = [
    "timeout", "unreachable", "malformed_response", "guardian_error",
    "observed_agent_error", "signature_invalid", "handshake_failure", "other",
  ];

  it.each(failureClasses)("validates session-end %s counters", (failureClass) => {
    for (const count of [0, 2, -1, 0.5, "1", null, true]) {
      const request = buildRequest(config, newSessionState(), "steps/sessionEnd", {
        reason: "completed",
        summary: { decision_failures: { [failureClass]: count } },
      });
      if (count === 0 || count === 2) {
        expect(() => validateRequest(request)).not.toThrow();
      } else {
        expect(() => validateRequest(request)).toThrow(/decision_failures/);
      }
    }
  });

  it("keeps failure counters optional and rejects unknown classes and nonobjects", () => {
    for (const payload of [
      { reason: "completed" },
      { reason: "completed", summary: {} },
      { reason: "completed", summary: { decision_failures: {} } },
    ]) {
      expect(() => validateRequest(buildRequest(config, newSessionState(), "steps/sessionEnd", payload))).not.toThrow();
    }
    for (const failures of [{ unknown: 1 }, [], null, 1, "timeout"]) {
      const request = buildRequest(config, newSessionState(), "steps/sessionEnd", {
        reason: "completed", summary: { decision_failures: failures },
      });
      expect(() => validateRequest(request)).toThrow(/decision_failures/);
    }
  });
});
