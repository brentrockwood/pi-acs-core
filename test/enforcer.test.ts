import { describe, expect, it } from "vitest";
import { modifiedToolInput, replaceObject } from "../src/enforcer.js";

const tool = {
  name: "demo",
  description: "test tool",
  parameters: {
    type: "object",
    properties: { command: { type: "string" }, count: { type: "number" } },
    required: ["command"],
    additionalProperties: false,
  },
} as never;

describe("tool modification", () => {
  it("validates and atomically replaces the same Pi input object", () => {
    const input: Record<string, unknown> = { command: "before", count: 1 };
    const replacement = modifiedToolInput(input, { parameter_overrides: { command: "after" } }, tool);
    replaceObject(input, replacement);
    expect(input).toEqual({ command: "after", count: 1 });
  });

  it("fails closed on invalid or unsupported modification shapes", () => {
    expect(() => modifiedToolInput({ command: "before" }, { parameter_overrides: { count: "wrong" } }, tool))
      .toThrow("must be number");
    expect(() => modifiedToolInput({ command: "before" }, { redactions: [{ path: "/command" }] }, tool))
      .toThrow("redactions are not supported");
  });
});
