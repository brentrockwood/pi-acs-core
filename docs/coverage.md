# Coverage and conformance boundary

Target contracts:

- ACS schema version: `0.1.0`
- ACS source revision: `db457a84393bd80954c9b70b2271a719bf7c61cd` (integration, 2026-11-08; includes merged signing and decision-failure clarifications)
- Reference-adapter revision: `4bdf367916a94ade4577bc9b3a38eae25072faed` (historical behavior baseline; upstream PR #22 merged on 2026-11-05)
- Pi package and extension API: `@earendil-works/pi-coding-agent` `0.84.3`, source revision `4e494929998d6bc4fccf75e0a233f727db4b70ee`

The adapter advertises only methods it emits. It currently sends no `profiles_supported` values. In particular, it does not claim `acs-core`. The recorded behavior below is not a conformance assertion.

## Instrument and system methods

| ACS method | Pi boundary | Status | Exact limitation |
|---|---|---|---|
| `handshake/hello` | `session_start` | Implemented | Pi fires this after its session object exists. It accepts the schema's direct `ServerHello` result when its embedded HMAC verifies, including over loopback HTTP; without an HMAC key, the direct result is accepted only over authenticated HTTPS. The legacy `AcsResult.payload` wrapper is rejected. A failed-closed handshake blocks later input and tools the extension can see, but cannot make the Pi session object cease to exist. |
| `steps/sessionStart` | `session_start` | Partial enforcement | Emitted after a successful handshake. DENY prevents later mediated actions. MODIFY has no meaningful Pi target and fails closed. |
| `steps/sessionEnd` | `session_shutdown` | Observe | Best effort. Pi shutdown is not held indefinitely for an unavailable Guardian. Reload/new/resume/fork map to `abandoned`; quit maps to `completed`. |
| `steps/userMessage` | `input` | Enforce | Covers input Pi routes through this event. It does not cover direct `!`/`!!` user shell execution. Wholesale text replacement is supported; structured redactions are not. |
| `steps/agentTrigger` | none | Unsupported | Pi's ordinary interactive path is represented as `userMessage`; no distinct autonomous trigger mapping is asserted. |
| `steps/toolCallRequest` | `tool_call` | Enforce | Covers model-initiated built-in and extension tools. ALLOW, DENY, human ASK, bounded DEFER, and schema-valid top-level `parameter_overrides` are handled. ACS redaction paths and wholesale replacement of structured arguments fail closed. |
| `steps/toolCallResult` | `tool_result` | Enforce content gate | Emitted after execution and before the result returns to the model. Whole-text replacement and blocking are supported. Pi `details` and `usage` are not sent. Structured redactions are not implemented. |
| `steps/agentResponse` | assistant `message_end` | Partial enforcement | Final stored content can be replaced or blocked. Interactive Pi may already have displayed streamed text, so this is not a confidentiality boundary for the TUI. Thinking records and tool-call records are deliberately omitted from response content. |
| `steps/turnStart`, `steps/turnEnd` | `turn_start`, `turn_end` | Unsupported in this alpha | Pi exposes both, but the adapter does not yet propagate a stable `turn_id` through every intervening step. Advertising partial turn semantics would make policy state misleading. |
| `steps/preCompact`, `steps/postCompact` | `session_before_compact`, `session_compact` | Unsupported in this alpha | Pi exposes the events. The current adapter does not manufacture ACS provenance, entry hashes, or post-compaction chain facts it cannot derive faithfully. |
| knowledge retrieval hooks | no single guaranteed boundary | Unsupported | Pi extensions and tools can implement retrieval in different ways. |
| memory hooks | no canonical Pi memory boundary | Unsupported | No synthetic observation is emitted. |
| skill lifecycle hooks | resource discovery, prompt expansion, and ordinary `read` calls | Unsupported | Pi can discover skill metadata and inject a `/skill:name` prompt, while model-driven loading appears as an ordinary file read. The extension API exposes no registration/load/unload event that binds a stable skill id to a digest of the complete artifact. No synthetic lifecycle observation is emitted. |
| subagent hooks | no built-in Pi subagent lifecycle | Unsupported | External extensions may create subprocess agents outside this adapter. |
| `system/ping` | `/acs-ping` | Implemented | Sent without a signature and never treated as an enforcement decision, as required by the pinned schema. |
| `protocols/MCP/*` | MCP tools eventually appear as Pi tool calls | Unsupported | The adapter sees the normalized Pi tool invocation, not the MCP protocol exchange, so it does not claim wrapped-MCP coverage. |
| AgBOM methods | none | Unsupported | The adapter does not inventory Pi components. |

## Dispositions

| Decision | Current behavior |
|---|---|
| ALLOW | Continue unchanged. If the Guardian did not list the method in `methods_evaluated`, the request is not sent, the omission is audited as `acs_unevaluated_allow`, and the local action continues. An evaluated `toolCallResult` never cites a skipped `toolCallRequest`. |
| DENY | Block input/tool execution or replace result/response content with a short blocked record. |
| MODIFY | Disabled unless `enableModify` is explicitly true. When enabled, tool calls accept top-level `parameter_overrides`, validate the complete candidate against Pi's tool schema, then mutate the original event input atomically. User messages, tool results, and agent responses accept only exclusive `modified_content`. Unsupported or conflicting shapes fail closed. |
| ASK | A human approver is routed to binary `ctx.ui.confirm()` with the Guardian's timeout. Custom `options`, `intent_extension`, non-human approvers, and unavailable UI are not supported and fail closed where they affect the decision. This alpha does not send a separate approval artifact back to the Guardian. |
| DEFER | The action is suspended for `resolution_timeout_ms`, then follows `timeout_decision`: deny, or ask the local user. It does not yet support out-of-band resolution or additional-context exchange. |

## Integrity and chain state

Requests and decision responses, except `system/ping`, use HMAC-SHA256 when configured. This includes the direct `ServerHello` result added by the PR #22 reference adapters. A signed JSON-RPC error envelope is also verified before the client surfaces its error; a missing or invalid error signature fails as a signature error. `system/ping` errors remain exempt because the pinned schema says the liveness method must not require a signature. The PR #22 reference adapters sign ordinary errors this way, although the current schema does not define an explicit `error.signature` property. Requiring it for non-ping methods when the session key is available is deliberate conservative interoperability behavior, not a conformance claim. Enforcement mode refuses unsigned configuration. The client verifies JSON-RPC ID, ACS `request_id` where present, signature key ID, applicable response/error signatures, selected transport, negotiated version, accepted profiles, and evaluated-method subset.

When a Guardian returns `chain_hash`, the adapter propagates it as the next request's `metadata.session_state.chain_hash` and includes the last value at session end. It does not construct or persist the Guardian's append-only ContextEntry chain and therefore does not claim full SessionContext conformance or ACS-Audit.

## Merged ACS-Core floor (upstream PR #21)

PR #21 merged on 2026-10-05. These are current requirements, but this adapter does not claim ACS-Core conformance.

- Pi's partial, schema-validated `MODIFY` handling remains opt-in. Under the merged specification, `MODIFY` is SHOULD-support; an unapplicable `MODIFY` must normally become `DENY` with audit, with a special `postCompact` exception. This adapter already fails closed on unsupported shapes but does not claim the full contract.
- `system/ping` is already implemented and sent by the observed agent. The specification makes it SHOULD-support and requires a deployment-named alternative when omitted; this does not expand the adapter's claim.
- Raw `protocols/MCP/*` remains absent. The specification requires wrapped coverage whenever a session involves MCP, except that MCP `tools/call` may use generic tool hooks. Pi's normalized tool calls do not expose resource reads, prompts, notifications, or negotiation, so only a deployment that genuinely never uses MCP could omit the namespace.
- Pi exposes no built-in subagent abstraction to this adapter, and it emits neither `steps/subagentStart` nor `steps/subagentStop`. The specification requires `subagentStart` for subagent-capable clients and makes `subagentStop` SHOULD-emit. The adapter does not extend the no-subagent exception to third-party extensions that create child agents outside its view.
- Skill lifecycle hooks are SHOULD-emit when the harness can observe the lifecycle. Pi's available events do not establish the stable id, complete-artifact digest, and activation boundary needed for honest `skillRegister`/`skillLoad`/`skillUnload` messages.
- Complete SessionContext persistence, full lifecycle coverage, and the exact end-to-end behavior required for a profile remain unproven.

## Parallel calls

Pi preflights sibling tool calls through `tool_call` and may execute allowed siblings concurrently. The adapter evaluates each call independently but serializes Guardian exchanges within one ACS session, so every request can carry the chain head returned by the preceding response. Its correlation state is keyed by Pi `toolCallId`, and each `toolCallResult.request_id_ref` refers to that call's own ACS tool-request ID. There is no batch-wide policy fact in this alpha.

## Tested claims

Automated tests currently establish:

- generated requests and received responses are rejected when the vendored schema says they are malformed;
- configured HMAC signatures, including signed JSON-RPC error envelopes, and applicable correlation IDs are checked;
- an explicit DENY returns Pi's pre-execution block result;
- a valid override changes the original input object and an invalid override does not partially mutate it;
- the pinned real Pi CLI loads the extension and routes model-originated Bash calls through it: ALLOW produces the expected filesystem side effect, DENY prevents it, and MODIFY causes the real tool to receive the replacement command;
- two concurrent allowed tool calls keep distinct result correlations;
- malformed, unsigned, mis-keyed, mis-correlated and signed-refusal Guardian responses block under a negotiated `proceed` posture, while a signed `-32603`, a bare 5xx, a timeout and a refused connection follow it;
- in the real Pi CLI, a signed handshake refusal with startup `proceed` refuses the session: the prompt is withheld at `input`, no step request is sent, and no Bash side effect occurs;
- default audit records omit payload bodies.

The end-to-end fixture uses a deterministic local model server and a loopback Guardian implemented with this repository's test helpers; it establishes Pi adapter behavior, not independent Guardian interoperability or real-model reliability. The tests do not establish containment, universal Pi event coverage, policy quality, Guardian correctness, OWASP approval, or ACS-Core conformance.

## Decision-failure evidence

Every failed client exchange, including handshake negotiation, is recorded once as `acs_decision_failure` with its failure class, request ID and configured posture. Counters are per ACS session. Session-end requests include `summary.decision_failures` for failures observed before the queued shutdown exchange starts; failure of that final exchange remains in the local audit record, not in an already-sent summary. Guardian DENY decisions are not decision failures.

Each failure record also carries a `disposition`: `availability` when no usable answer arrived and the configured posture applied; `refusal` when the Guardian answered with an authenticated JSON-RPC error other than `-32603` or a bare HTTP 4xx other than 408; `integrity` when the answer failed verification or the request could not be formed. Refusal and integrity block in enforce mode under either posture, as SECURITY.md describes. The JSON-RPC `error_code` and `http_status` are recorded when present. `summary.decision_failures` keeps the standard failure classes; no local counter was added to the wire.

Without an audit path, failure records go to stderr. If a configured file cannot be written, that record falls back to stderr without changing the enforcement decision. Operators must capture stderr or provide a writable audit path; this is not a durable-delivery guarantee. Host-handler records such as `acs_fail_open` provide additional context but do not increment the exchange counter.

Audit message text is omitted along with payloads unless file payload logging is explicitly enabled. Stderr fallback always omits both, including when an opted-in file sink fails. Failure class, kind and correlation IDs remain available.
