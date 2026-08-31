import type {
  ExtensionAPI,
  ExtensionContext,
  InputEventResult,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { AcsClient } from "./client.js";
import { loadConfig } from "./config.js";
import { blockingReason, modifiedToolInput, replaceObject } from "./enforcer.js";
import {
  newSessionState,
  observableContentPayload,
  toolCallPayload,
  toolResultPayload,
} from "./mapper.js";
import { AcsClientError, type AcsResult, type JsonObject } from "./types.js";

type GateOutcome =
  | { action: "allow"; requestId?: string }
  | { action: "modify"; modifications: NonNullable<AcsResult["modifications"]>; requestId?: string }
  | { action: "deny"; reason: string; requestId?: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function resolveAsk(result: AcsResult, ctx: ExtensionContext): Promise<GateOutcome> {
  const details = result.ask_details as {
    approver?: { type?: string; id?: string };
    question?: string;
    context?: string;
    options?: string[];
    timeout_seconds?: number;
    timeout_disposition?: "allow" | "deny";
    intent_extension?: JsonObject;
  } | undefined;
  if (
    details?.approver?.type !== "human"
    || !details.question
    || !details.timeout_seconds
    || details.options !== undefined
    || details.intent_extension !== undefined
  ) {
    return { action: "deny", reason: "Guardian returned an ASK this adapter cannot route" };
  }
  const timeoutMilliseconds = details.timeout_seconds * 1_000;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const confirmation = ctx.ui.confirm(
      `ACS approval: ${details.approver.id ?? "human"}`,
      details.context ? `${details.question}\n\n${details.context}` : details.question,
      { signal: controller.signal },
    );
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMilliseconds);
    });
    const response = await Promise.race([
      confirmation.then((approved) => approved ? "approved" as const : "rejected" as const),
      timedOut,
    ]);
    if (response === "timeout") {
      return details.timeout_disposition === "allow"
        ? { action: "allow" }
        : { action: "deny", reason: "ACS approval timed out" };
    }
    const approved = response === "approved";
    return approved
      ? { action: "allow" }
      : { action: "deny", reason: result.reasoning ?? "Approval was not granted" };
  } catch {
    return { action: "deny", reason: "ACS approval UI failed" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveDefer(result: AcsResult, ctx: ExtensionContext): Promise<GateOutcome> {
  const details = result.defer_details as {
    reason?: string;
    resolution_method?: string;
    resolution_timeout_ms?: number;
    timeout_decision?: "deny" | "ask";
  } | undefined;
  if (!details || typeof details.resolution_timeout_ms !== "number") {
    return { action: "deny", reason: "Guardian returned malformed DEFER details" };
  }
  const resolutionTimeoutMs = details.resolution_timeout_ms;
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(resolutionTimeoutMs, 2_147_483_647)));
  if (details.timeout_decision === "ask") {
    try {
      const approved = await ctx.ui.confirm(
        "ACS deferred decision",
        `${result.reasoning ?? details.reason ?? "The Guardian could not reach a verdict."}\n\nProceed anyway?`,
      );
      return approved ? { action: "allow" } : { action: "deny", reason: "Deferred action was not approved" };
    } catch {
      return { action: "deny", reason: "Deferred action could not be approved" };
    }
  }
  return { action: "deny", reason: result.reasoning ?? "Guardian deferral expired" };
}

async function resolveDecision(result: AcsResult, ctx: ExtensionContext, enableModify: boolean): Promise<GateOutcome> {
  if (result.decision === "allow") return { action: "allow" };
  if (result.decision === "deny") return { action: "deny", reason: blockingReason(result) ?? "Denied by ACS Guardian" };
  if (result.decision === "ask") return resolveAsk(result, ctx);
  if (result.decision === "defer") return resolveDefer(result, ctx);
  if (!enableModify) return { action: "deny", reason: "Guardian returned MODIFY but modification is disabled" };
  if (!result.modifications) return { action: "deny", reason: "Guardian returned MODIFY without modifications" };
  return { action: "modify", modifications: result.modifications };
}

function replacementText(modifications: NonNullable<AcsResult["modifications"]>): string | undefined {
  if (
    modifications.modified_content !== undefined
    && !modifications.redactions?.length
    && modifications.parameter_overrides === undefined
  ) {
    return modifications.modified_content;
  }
  return undefined;
}

export default function acsCoreExtension(pi: ExtensionAPI): void {
  const loaded = loadConfig();
  const config = loaded?.config;
  const client = config ? new AcsClient(config) : undefined;
  let state = newSessionState();
  const toolRequestIds = new Map<string, string>();

  function enforcementEnabled(): boolean {
    return config?.mode === "enforce";
  }

  function failureBlocks(): boolean {
    if (!enforcementEnabled() || !config || !client) return false;
    return state.handshake ? client.failurePosture(state) === "deny" : config.startupPosture === "refuse";
  }

  async function request(method: string, payload: JsonObject): Promise<AcsResult | undefined> {
    if (!client || !state.handshake) return undefined;
    const result = await client.request(state, method, payload);
    if (!client.isEvaluated(state, method)) {
      await client.record({
        event: "acs_unevaluated_allow",
        session_id: state.sessionId,
        request_id: result.request_id,
        method,
        decision: result.decision,
      });
      return { ...result, decision: "allow" };
    }
    if (!enforcementEnabled()) {
      await client.record({
        event: "acs_observe_only",
        session_id: state.sessionId,
        request_id: result.request_id,
        method,
        decision: result.decision,
      });
      return { ...result, decision: "allow" };
    }
    return result;
  }

  async function recordFailOpen(method: string, error: unknown): Promise<void> {
    await client?.record({
      event: "acs_fail_open",
      session_id: state.sessionId,
      method,
      failure_kind: error instanceof AcsClientError ? error.kind : "transport",
      message: errorMessage(error),
    });
  }

  async function guardedDecision(
    method: string,
    payload: JsonObject,
    ctx: ExtensionContext,
  ): Promise<GateOutcome> {
    if (state.refuseActions && enforcementEnabled()) {
      return { action: "deny", reason: "ACS session is not guarded and startup posture is refuse" };
    }
    try {
      const result = await request(method, payload);
      if (!result) return { action: "allow" };
      const outcome = await resolveDecision(result, ctx, config?.enableModify === true);
      return { ...outcome, requestId: result.request_id };
    } catch (error) {
      if (failureBlocks()) return { action: "deny", reason: `ACS decision failure: ${errorMessage(error)}` };
      await recordFailOpen(method, error);
      return { action: "allow" };
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    state = newSessionState();
    toolRequestIds.clear();
    if (!client || !config) {
      ctx.ui.setStatus("acs-core", undefined);
      return;
    }
    try {
      state.handshake = await client.handshake(state);
      state.guarded = true;
      ctx.ui.setStatus("acs-core", config.mode === "enforce" ? "ACS enforcing" : "ACS observing");
      const outcome = await guardedDecision("steps/sessionStart", {}, ctx);
      if (outcome.action !== "allow") {
        state.refuseActions = true;
        const reason = outcome.action === "deny" ? outcome.reason : "sessionStart MODIFY is not meaningful to this adapter";
        ctx.ui.notify(`ACS session start denied: ${reason}`, "error");
      }
    } catch (error) {
      state.guarded = false;
      state.refuseActions = enforcementEnabled() && config.startupPosture === "refuse";
      ctx.ui.setStatus("acs-core", state.refuseActions ? "ACS refused" : "ACS unguarded");
      ctx.ui.notify(`ACS Guardian handshake failed: ${errorMessage(error)}`, state.refuseActions ? "error" : "warning");
      await client.record({
        event: state.refuseActions ? "acs_startup_refused" : "acs_session_unguarded",
        session_id: state.sessionId,
        failure_kind: error instanceof AcsClientError ? error.kind : "transport",
        message: errorMessage(error),
      });
    }
  });

  pi.on("input", async (event, ctx): Promise<InputEventResult> => {
    const payload = observableContentPayload([
      { type: "text", text: event.text },
      ...(event.images ?? []),
    ]);
    if (!payload) return { action: "continue" };
    const outcome = await guardedDecision("steps/userMessage", payload, ctx);
    if (outcome.action === "allow") return { action: "continue" };
    if (outcome.action === "deny") {
      ctx.ui.notify(`ACS blocked input: ${outcome.reason}`, "error");
      return { action: "handled" };
    }
    const text = replacementText(outcome.modifications);
    if (text === undefined) {
      ctx.ui.notify("ACS blocked an unsupported user-message modification", "error");
      return { action: "handled" };
    }
    return { action: "transform", text };
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult> => {
    const outcome = await guardedDecision(
      "steps/toolCallRequest",
      toolCallPayload(event.toolName, event.input),
      ctx,
    );
    if (outcome.action === "deny") {
      await client?.record({
        event: "acs_tool_blocked",
        session_id: state.sessionId,
        call_id: event.toolCallId,
        ...(outcome.requestId ? { request_id: outcome.requestId } : {}),
        tool: event.toolName,
        decision: "deny",
        message: outcome.reason,
      });
      return { block: true, reason: outcome.reason };
    }
    if (outcome.action === "allow") {
      // The response request_id links the later toolCallResult to this request.
      // It is available only for evaluated requests; otherwise omission is valid.
      if (outcome.requestId) toolRequestIds.set(event.toolCallId, outcome.requestId);
      return {};
    }
    try {
      const tool = pi.getAllTools().find((candidate) => candidate.name === event.toolName);
      replaceObject(event.input, modifiedToolInput(event.input, outcome.modifications, tool));
      if (outcome.requestId) toolRequestIds.set(event.toolCallId, outcome.requestId);
      await client?.record({
        event: "acs_tool_modified",
        session_id: state.sessionId,
        call_id: event.toolCallId,
        ...(outcome.requestId ? { request_id: outcome.requestId } : {}),
        tool: event.toolName,
      });
      return {};
    } catch (error) {
      await client?.record({
        event: "acs_invalid_modification",
        session_id: state.sessionId,
        call_id: event.toolCallId,
        ...(outcome.requestId ? { request_id: outcome.requestId } : {}),
        method: "steps/toolCallRequest",
        tool: event.toolName,
        decision: "deny",
        message: errorMessage(error),
      });
      return { block: true, reason: `ACS tool modification rejected: ${errorMessage(error)}` };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const requestId = toolRequestIds.get(event.toolCallId);
    await client?.record({
      event: "acs_tool_completed",
      session_id: state.sessionId,
      call_id: event.toolCallId,
      ...(requestId ? { request_id: requestId } : {}),
      tool: event.toolName,
      exit_status: event.isError ? "failure" : "success",
    });
    const outcome = await guardedDecision(
      "steps/toolCallResult",
      toolResultPayload(event.toolName, requestId, event.content, event.isError),
      ctx,
    );
    toolRequestIds.delete(event.toolCallId);
    if (outcome.action === "allow") return {};
    if (outcome.action === "deny") {
      return { content: [{ type: "text", text: `Blocked by ACS Guardian: ${outcome.reason}` }], isError: true };
    }
    const text = replacementText(outcome.modifications);
    if (text === undefined) {
      return { content: [{ type: "text", text: "Blocked: unsupported ACS tool-result modification" }], isError: true };
    }
    return { content: [{ type: "text", text }], isError: event.isError };
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return {};
    const payload = observableContentPayload(event.message.content);
    if (!payload) return {};
    const outcome = await guardedDecision("steps/agentResponse", payload, ctx);
    if (outcome.action === "allow") return {};
    const text = outcome.action === "deny"
      ? `Blocked by ACS Guardian: ${outcome.reason}`
      : replacementText(outcome.modifications);
    if (text === undefined) {
      return { message: { ...event.message, content: [{ type: "text", text: "Blocked: unsupported ACS response modification" }] } };
    }
    return { message: { ...event.message, content: [{ type: "text", text }] } };
  });

  pi.on("session_shutdown", async (event) => {
    if (!client || !state.handshake) return;
    try {
      await client.request(state, "steps/sessionEnd", {
        reason: event.reason === "quit" ? "completed" : "abandoned",
        ...(state.chainHash ? { final_chain_hash: state.chainHash } : {}),
      });
    } catch (error) {
      await client.record({
        event: "acs_session_end_failure",
        session_id: state.sessionId,
        method: "steps/sessionEnd",
        message: errorMessage(error),
      });
    }
  });

  pi.registerCommand("acs-status", {
    description: "Show ACS Guardian status for this Pi session",
    handler: async (_args, ctx) => {
      if (!config || !loaded) {
        ctx.ui.notify("ACS is disabled: no configuration file was found", "info");
        return;
      }
      const methods = state.handshake?.methods_evaluated.join(", ") || "none";
      ctx.ui.notify(
        `ACS ${state.guarded ? "connected" : "not connected"}; mode=${config.mode}; config=${loaded.path}; evaluated=${methods}`,
        state.guarded ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("acs-ping", {
    description: "Send an ACS system/ping request to the configured Guardian",
    handler: async (_args, ctx) => {
      if (!client || !state.handshake) {
        ctx.ui.notify("ACS Guardian is not connected", "warning");
        return;
      }
      try {
        await client.request(state, "system/ping", {});
        ctx.ui.notify("ACS Guardian responded", "info");
      } catch (error) {
        ctx.ui.notify(`ACS ping failed: ${errorMessage(error)}`, "error");
      }
    },
  });
}
