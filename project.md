# Pi ACS-Core adapter

## Important things to know first

- The [Pi](https://pi.dev/) coding agent
- The OWASP GenAI-Security-Project [Agent Control Standard](https://agentcontrolstandard.org/) ([repo](https://github.com/GenAI-Security-Project/agent-control-standard))

## Why this exists

Pi has a capable extension system and a growing ecosystem of real policy extensions. The OWASP GenAI Security Project's Agent Control Standard (ACS) has a canonical, machine-readable Core schema but few, if any, public adapters for coding agents. A small Pi package can make the two useful to each other now:

- Pi users get a portable control/observability boundary around agent activity.
- ACS gets a concrete, open reference adapter for a popular agent harness.
- Rockwood Lab gets a modest, technically honest public contribution rather than a claim to have built an enterprise control plane.

This project is separate from Hammer. It must not imply that Hammer validates ACS, that ACS is a sandbox, or that this package is an OWASP-endorsed implementation unless an authorized OWASP maintainer says so.

## Product statement

Publish an open-source Pi extension package that maps the Pi lifecycle and tool boundaries it can faithfully observe to the canonical ACS-Core envelopes, sends them to a configured Guardian, and enforces the Guardian's supported decisions at those boundaries.

The first release is an **experimental ACS v0.1 Pi adapter**. It is useful if it can demonstrably observe the supported hooks, fail closed where configured, and apply a Guardian denial or valid modification to the same tool invocation Pi executes.

## Non-goals for v0.1

- Creating a new policy language, Guardian product, dashboard, SIEM integration, or AgBOM generator.
- Claiming complete ACS coverage or certification.
- Claiming containment, filesystem isolation, network control, backend authorization, or safety from prompt injection.
- Governing text already streamed to Pi's TUI before a post-response decision is available.
- Reimplementing `@gotgenes/pi-permission-system`. It is a useful example of Pi-native gate design, not the ACS authority or a dependency to fork.
- Publishing to npm, changing Pi, or calling the project an official OWASP integration without an explicit human decision at that time.

## Primary user story

An operator starts Pi with the extension and a local or remote Guardian URL. When the model proposes a tool call, the extension sends the canonical ACS request. A Guardian can allow it, deny it with a reason, ask/defer to the operator, or return a schema-valid modification. Pi then executes exactly the allowed or modified invocation, records the correlation, and returns the result through the corresponding ACS observation path.

The smallest compelling demo is intentionally mundane:

1. A Pi prompt causes a `bash` or `write` tool request.
2. A toy Guardian permits one request, denies another, and rewrites a third's argument.
3. The adapter demonstrates that the denied operation did not execute and that the rewritten operation executed with the exact rewritten arguments.
4. A malformed Guardian response and an unavailable Guardian take the documented configured failure path.

## Design rules

1. **Canonical ACS is the source of truth.** Pin a reviewed ACS schema revision and generate or validate against it. Do not invent envelope fields, action names, or hook semantics from prose.
2. **Pi is the host.** The adapter never claims to control paths Pi does not route through it.
3. **Evaluate the value that executes.** A modification must be validated, bound to the original request ID, and applied to the exact Pi input that will run. Never evaluate one argument object and execute a later independently constructed one.
4. **Default to legible failure.** The package must distinguish an explicit Guardian deny from transport, timeout, schema, and internal adapter failures. A production-safe configuration may fail closed; a development configuration may fail open only when the user selects it explicitly and the event records that fact.
5. **No secret-by-accident telemetry.** Log only fields that the operator configures and understands. Do not describe a local log as safe to publish.
6. **No fake coverage.** Unsupported ACS hooks must be reported as unsupported or omitted; they must never be synthesized as if Pi emitted them.

## Proposed package shape

Use a normal Pi package, initially named `@rockwood-lab/pi-acs-core` only if that npm scope/name is available and deliberately chosen. Keep the public package name provisional until publication.

```text
pi-acs-core/
  src/
    index.ts                 Pi extension factory and configuration loading
    config.ts                strict local configuration schema
    acs-client.ts            Guardian transport, timeout, request IDs
    acs-schema.ts            pinned schema validator and typed boundary values
    mapper.ts                Pi-event to ACS request mapping
    enforcer.ts              verdict handling and safe tool-input replacement
    audit.ts                 optional local structured event sink
    support.ts               declared coverage and unsupported-hook reporting
  test/
    fixtures/                pinned ACS envelopes and Guardian responses
    mapper.test.ts
    enforcer.test.ts
    integration.test.ts
  examples/
    guardian-demo.ts         deliberately tiny local Guardian
    config.json
  README.md
  SECURITY.md
  package.json
```

The package should have no need to patch Pi. If a required Pi boundary cannot be faithfully mediated from an extension, record the gap and propose a narrow upstream hook separately.

## Coverage contract for the first release

The implementation must verify the exact current ACS names and required fields from the pinned schema before coding. This table is a planning map, not a substitute for that check.

| ACS family | Pi boundary | v0.1 treatment |
|---|---|---|
| Session start/end | `session_start`, `session_shutdown` | Observe |
| Agent trigger / user message | `input`, `before_agent_start` | Observe; do not claim every UI path is mediated until tested |
| Turn start/end | `turn_start`, `turn_end` | Observe |
| Agent response | finalized assistant `message_end` | Observe after complete message; document streamed-display limitation |
| Tool call request | `tool_call` | Enforce allow, deny, configured ask/defer, and validated modification |
| Tool call result | `tool_result` | Observe; only transform if Pi's exact result semantics and ACS target binding are verified |
| Pre/post compaction | `session_before_compact`, `session_compact` | Observe |
| Skill lifecycle / subagent lifecycle / AgBOM / system ping | Pi-dependent | Unsupported unless a tested Pi event exists |

`tool_call` is the release-critical boundary. Pi permits handlers to mutate tool inputs and block a call, but does not revalidate a mutated input. The adapter therefore owns validation of a modified policy target before it replaces Pi's input.

## Configuration sketch

The shipped schema and docs must settle exact names. The first user-facing configuration should nevertheless remain small:

```json
{
  "guardian": {
    "url": "http://127.0.0.1:8787",
    "timeoutMs": 2000,
    "onUnavailable": "deny"
  },
  "mode": "enforce",
  "audit": {
    "path": ".pi/acs-events.jsonl",
    "includePayloads": false
  }
}
```

Do not silently use a network Guardian. `guardian.url` must be explicit. Do not put credentials in example configuration, fixtures, command lines, or default logs.

## Phased plan

Each numbered task is intentionally bounded to roughly 40–50% of a typical model context window. Give a coding agent one numbered task at a time. It should inspect, implement, test, and report only that task; do not ask it to complete an entire phase in one turn.

### Phase 0 — Freeze the contracts

**0.1 — Create the package skeleton.**

Create a new repository/package with TypeScript, Pi extension manifest, test runner, formatting, MIT license decision, and a terse README stating that it is experimental. Do not add ACS behavior yet.

Acceptance: `npm test` and type checking run; Pi can discover and load a no-op extension from the package.

**0.2 — Vendor or pin the ACS-Core schema deliberately.**

Record the ACS repository commit or release used, its license, the specific JSON schema entry point, and every schema file needed for reference resolution. Add a small validation test for one canonical request and response fixture.

Acceptance: schema validation runs offline and fails on a deliberately malformed envelope. The README names the exact ACS revision, not merely “latest.”

**0.3 — Write the adapter coverage contract.**

Inspect the pinned ACS hook and verdict schemas plus the Pi version's extension types. Create `docs/coverage.md`: for every ACS-Core hook, name its Pi event, whether it is observe/enforce/unsupported, what data is lost, and why.

Acceptance: no unsupported hook is called supported; any uncertain mapping is labelled pending rather than guessed.

### Phase 1 — Build a trustworthy adapter core

**1.1 — Implement strict configuration loading.**

Add one documented project-local/global configuration location, strict validation, secure defaults, explicit timeouts, and an explicit unavailable-Guardian policy. Reject unknown configuration keys in enforce mode.

Acceptance: tests cover valid config, absent Guardian URL, bad URL, invalid timeout, and explicit fail-open/fail-closed choices.

**1.2 — Implement the typed Guardian client.**

Build a small transport interface with a fetch-backed implementation, correlation IDs, timeout/cancellation, request and response validation, and normalized error categories. Keep the Guardian protocol exact to the pinned ACS envelope.

Acceptance: fixture tests cover allow, deny, ask/defer if present in the canonical schema, modify if present, malformed response, timeout, non-2xx response, and cancellation.

**1.3 — Implement pure Pi-to-ACS mappers.**

Map the selected lifecycle, turn, user-input, finalized-response, compaction, tool-request, and tool-result events into pure serializable values. Keep mapping separate from transport and enforcement.

Acceptance: one fixture per supported boundary asserts stable IDs, parent/correlation relationships, actor/session facts available from Pi, and deliberate omissions.

### Phase 2 — Enforce at the consequential boundary

**2.1 — Add `tool_call` allow and deny enforcement.**

Invoke the Guardian before execution. Return Pi's blocking result on deny or a configured unavailable-Guardian failure, and include a concise reason safe for the model/UI.

Acceptance: an integration test proves a denied custom tool and a denied built-in write/bash action do not execute.

**2.2 — Add human escalation only after the canonical semantics are clear.**

If ACS-Core's pinned response schema supports an ask/defer/escalate decision, map it to Pi's `ctx.ui.confirm()` in interactive mode and a documented non-interactive failure behavior. Do not make an unreviewed decision look like user approval.

Acceptance: tests cover approve, reject, no UI, cancellation, and Guardian timeout while awaiting a decision.

**2.3 — Add safe modification.**

Support modification only for tool fields whose Pi types and ACS policy target are both explicit. Validate the returned replacement target against the original tool schema, atomically apply it to Pi's event input, then emit the enforcement record.

Acceptance: a test proves the executed tool receives the replacement; invalid, out-of-scope, or mismatched modifications block rather than partially mutating arguments.

**2.4 — Decide parallel-call semantics.**

Pi can preflight sibling tool calls sequentially but execute them concurrently. Document whether the adapter evaluates each sibling independently, whether it provides the Guardian a shared batch fact, and how correlation/log order are preserved.

Acceptance: an integration test uses two same-turn tool calls and demonstrates the stated behavior without a data race or an unlogged call.

### Phase 3 — Complete the useful observation loop

**3.1 — Add tool-result observation.**

Send an ACS tool-result event after Pi has executed the tool but before its result becomes the next model-context message, to the extent Pi's event ordering guarantees this. Do not promise result mutation in v0.1.

Acceptance: a test demonstrates actual event order and correlation to the tool request.

**3.2 — Add lifecycle and compaction observation.**

Wire the Phase 1 mappers to live Pi events. Make shutdown best effort with a bounded flush; it must never prevent Pi from exiting.

Acceptance: one sample session yields an ordered local audit trace with a session, trigger, turns, tool request/result, and shutdown.

**3.3 — Add minimal audit output.**

Implement optional JSONL records with event type, stable IDs, decision category, timing, ACS/Pi/package versions, and failure category. Payload bodies remain off by default.

Acceptance: a test shows sensitive tool arguments are absent under the default audit configuration, and an explicit payload mode is visibly labelled as sensitive.

### Phase 4 — Make the claims earnable

**4.1 — Build a local demo Guardian.**

Create a tiny fixture Guardian—not a policy engine—that returns deterministic canonical responses for allow, deny, modification, malformed response, and delay/timeout. Keep it in examples or tests, never as a production service.

Acceptance: the README demo runs without an account or a cloud dependency and produces the expected audit trace.

**4.2 — Add a conformance matrix and negative tests.**

Turn `docs/coverage.md` into executable tests where possible. Include modified-input validation, schema reference resolution, unavailable Guardian, malformed Guardian result, no-UI escalation, parallel calls, and extension reload/session shutdown.

Acceptance: CI runs the suite; the README states exactly which claims those tests support.

**4.3 — Write security and operator documentation.**

Document threat boundary, trust assumptions, privacy/logging tradeoffs, trusted policy/Guardian configuration, failure modes, Pi version support, and what is not mediated. Include a short installation and removal path.

Acceptance: a new user can install, run the demo, understand what it does not protect, and remove it without having to inspect source.

### Phase 5 — Release intentionally

**5.1 — Conduct a claim review.**

Read every README, package description, and release-note sentence against the implementation and tests. Replace “ACS compliant,” “secure,” “enforces all Pi actions,” and “official” with narrower language unless each is independently justified.

Acceptance: a reviewer can point from every material claim to a test, pinned schema, or clearly labelled limitation.

**5.2 — Publish only with human approval.**

Choose package name, license, repository visibility, npm provenance, release version, and announcement language. Open an issue or discussion with ACS/Pi maintainers only after there is a reproducible public repository and no claim that they have endorsed it.

Acceptance: tag, npm publish, and external announcements are separate human-authorized actions.

## Definition of done for the first public release

- Pi loads the package as a normal extension.
- The package validates requests/responses against a pinned canonical ACS schema set.
- A configured Guardian can allow and deny tool calls before execution.
- A supported modification is schema-validated and bound to the exact invocation Pi executes.
- Guardian unavailability follows an explicit documented policy, with test coverage.
- Supported lifecycle/tool events have stable correlation IDs and an optional privacy-conscious audit trace.
- The repository contains a runnable local demo Guardian and negative tests.
- Documentation says “experimental adapter,” names its supported Pi and ACS versions, and directly states unsupported/unsafe boundaries.

## Questions to resolve before implementation begins

1. Which ACS revision and branch are the canonical target for this effort today?
2. Does ACS-Core's current response schema define `ask`, `defer`, and `modify` as first-class outcomes, and which are normative versus proposed?
3. Should the initial Guardian transport be HTTP only, an in-process interface only, or both behind one client abstraction?
4. Should default enforcement be fail closed, or should the first demo default to observe mode until the operator opts in?
5. Is a Rockwood Lab GitHub organization/package namespace available and wanted, or should the project start under a personal namespace?

Do not block Phase 0.1 on these questions. Block each later decision only where it changes a published protocol, enforcement default, or package identity.
