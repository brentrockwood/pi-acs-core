import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { validateWithToolSchema } from "./schema.js";
import { AcsClientError, type AcsModifications, type AcsResult } from "./types.js";

function cloneInput(input: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(input);
}

export function modifiedToolInput(
  input: Record<string, unknown>,
  modifications: AcsModifications,
  tool: ToolInfo | undefined,
): Record<string, unknown> {
  if (modifications.modified_content !== undefined) {
    throw new AcsClientError("invalid_modification", "modified_content cannot replace structured tool arguments");
  }
  if (modifications.redactions && modifications.redactions.length > 0) {
    throw new AcsClientError("invalid_modification", "tool argument redactions are not supported in this release");
  }
  if (!modifications.parameter_overrides) {
    throw new AcsClientError("invalid_modification", "tool modification has no parameter_overrides");
  }
  if (!tool) throw new AcsClientError("invalid_modification", "tool schema is unavailable");
  const candidate = { ...cloneInput(input), ...structuredClone(modifications.parameter_overrides) };
  const validationError = validateWithToolSchema(tool.parameters, candidate);
  if (validationError) throw new AcsClientError("invalid_modification", validationError);
  return candidate;
}

export function replaceObject(target: Record<string, unknown>, replacement: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, replacement);
}

export function blockingReason(result: AcsResult): string | undefined {
  if (result.decision === "allow" || result.decision === "modify") return undefined;
  if (result.decision === "ask") return `Guardian requested approval that this adapter cannot resolve: ${result.reasoning}`;
  if (result.decision === "defer") return `Guardian deferred this action: ${result.reasoning}`;
  return result.reasoning ?? "Denied by ACS Guardian";
}
