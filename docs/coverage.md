# Coverage and conformance boundary

Target contracts:

- ACS schema version: `0.1.0`
- ACS source revision: `c7ad162f69386daac94b89073e3b751e8cdf28b2`
- Pi package and extension API: `@earendil-works/pi-coding-agent` `0.84.3`, source revision `4e494929998d6bc4fccf75e0a233f727db4b70ee`

The adapter advertises only methods it emits. It currently sends no `profiles_supported` values. In particular, it does not claim `acs-core`: ACS-Core also requires wrapped MCP, a complete SessionContext chain, and fully interoperable handling of every disposition. Shipping useful enforcement without that label is more accurate than treating the six minimum hooks as the entire profile.

## Instrument and system methods

| ACS method | Pi boundary | Status | Exact limitation |
|---|---|---|---|
| `handshake/hello` | `session_start` | Implemented | Pi fires this after its session object exists. A failed-closed handshake blocks later input and tools the extension can see, but cannot make the Pi session object cease to exist. |
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
| skill lifecycle hooks | resource discovery/loading does not expose the required lifecycle contract | Unsupported | No synthetic observation is emitted. |
| subagent hooks | no built-in Pi subagent lifecycle | Unsupported | External extensions may create subprocess agents outside this adapter. |
| `system/ping` | `/acs-ping` | Implemented | Sent without a signature and never treated as an enforcement decision, as required by the pinned schema. |
| `protocols/MCP/*` | MCP tools eventually appear as Pi tool calls | Unsupported | The adapter sees the normalized Pi tool invocation, not the MCP protocol exchange, so it does not claim wrapped-MCP coverage. |
| AgBOM methods | none | Unsupported | The adapter does not inventory Pi components. |

## Dispositions

| Decision | Current behavior |
|---|---|
| ALLOW | Continue unchanged. If the Guardian did not list the method in `methods_evaluated`, the response is treated as ALLOW regardless of the returned decision. |
| DENY | Block input/tool execution or replace result/response content with a short blocked record. |
| MODIFY | Disabled unless `enableModify` is explicitly true. When enabled, tool calls accept top-level `parameter_overrides`, validate the complete candidate against Pi's tool schema, then mutate the original event input atomically. User messages, tool results, and agent responses accept only exclusive `modified_content`. Unsupported or conflicting shapes fail closed. |
| ASK | A human approver is routed to binary `ctx.ui.confirm()` with the Guardian's timeout. Custom `options`, `intent_extension`, non-human approvers, and unavailable UI are not supported and fail closed where they affect the decision. This alpha does not send a separate approval artifact back to the Guardian. |
| DEFER | The action is suspended for `resolution_timeout_ms`, then follows `timeout_decision`: deny, or ask the local user. It does not yet support out-of-band resolution or additional-context exchange. |

## Integrity and chain state

Requests and responses, except `system/ping`, use HMAC-SHA256 when configured. Enforcement mode refuses unsigned configuration. The client verifies JSON-RPC ID, ACS `request_id`, signature key ID, response signature, selected transport, negotiated version, accepted profiles, and evaluated-method subset.

When a Guardian returns `chain_hash`, the adapter propagates it as the next request's `metadata.session_state.chain_hash` and includes the last value at session end. It does not construct or persist the Guardian's append-only ContextEntry chain and therefore does not claim full SessionContext conformance or ACS-Audit.

## Parallel calls

Pi preflights sibling tool calls through `tool_call` and may execute allowed siblings concurrently. The adapter evaluates each call independently but serializes Guardian exchanges within one ACS session, so every request can carry the chain head returned by the preceding response. Its correlation state is keyed by Pi `toolCallId`, and each `toolCallResult.request_id_ref` refers to that call's own ACS tool-request ID. There is no batch-wide policy fact in this alpha.

## Tested claims

Automated tests currently establish:

- generated requests and received responses are rejected when the vendored schema says they are malformed;
- configured HMAC signatures and both correlation IDs are checked;
- an explicit DENY returns Pi's pre-execution block result;
- a valid override changes the original input object and an invalid override does not partially mutate it;
- the pinned real Pi CLI loads the extension and routes model-originated Bash calls through it: ALLOW produces the expected filesystem side effect, DENY prevents it, and MODIFY causes the real tool to receive the replacement command;
- two concurrent allowed tool calls keep distinct result correlations;
- malformed or timed-out Guardian responses reach the configured decision-failure path;
- default audit records omit payload bodies.

The end-to-end fixture uses a deterministic local model server and a loopback Guardian implemented with this repository's test helpers; it establishes Pi adapter behavior, not independent Guardian interoperability or real-model reliability. The tests do not establish containment, universal Pi event coverage, policy quality, Guardian correctness, OWASP approval, or ACS-Core conformance.
