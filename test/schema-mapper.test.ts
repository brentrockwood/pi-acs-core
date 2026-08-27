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
