# Upstream emission tests — 2026-11-19

## What passed

Two new cases in `test/pi-runtime.e2e.test.ts` drive the real **Pi 0.84.3** CLI,
this extension and a deterministic local model server:

- ALLOW writes the expected temporary file; DENY prevents a harmless marker-bearing write.
- Both sessions emit exactly one handshake, session start, user message, tool request,
  assistant response and session end, in order. The allowed call also emits exactly one
  linked successful tool result; the denied call emits no result.
- Every captured request passes upstream validation. IDs/nonces are unique; session,
  platform and version metadata are consistent; payloads contain the actual fixture data.
- The audit confirms signed replies were verified, each step got the expected decision,
  and no startup or decision failure substituted for the intended policy denial.

Final full check with capture and the existing Python example Guardian enabled:
**128 passed, 6 skipped**. The six skips are the separate Go-Guardian tests because
that server was not running. Typecheck and lint passed. The same counts passed again in a
separate temporary copy with its own fresh `npm ci --ignore-scripts` installation;
lint and `npm pack --dry-run --ignore-scripts` passed there too. The earlier Go experiment's
evidence is separate; it was not rerun for this change.

## Pinned upstream oracle

The oracle is `acs.testing.capture_guardian.CaptureGuardian` from ACS commit
`02b24e7c1398794957f8b54ceed0c8a54292706f`. The package's canonical schemas and independent
HKDF/HMAC/JCS verifier check the actual HTTP requests emitted by the running host.
Our Python bridge does not implement those checks. It programs only an ALLOW default,
a DENY for the harmless `# acs-deny` command marker, and a ping answer without the
upstream generic fixture's dummy chain head.

The bridge requires at least one capture, calls upstream's `assert_all_valid`,
and rejects duplicate request IDs. The TypeScript driver rejects invalid reports,
process failures and startup/shutdown timeouts. Python runs in isolated mode;
`ACS_SPEC_DIR` is removed so a local schema override cannot replace the pinned oracle.
Four bridge controls prove a valid request passes and an empty capture, bad HMAC,
and correctly signed malformed payload fail. The host cases separately require
the expected emissions and correlated verified decisions, not just an empty error list.

The upstream capture/signing-vector tests also passed locally: 20 tests. Those
upstream tests emitted socket ResourceWarnings but no test failures. Local evidence
used a non-editable wheel with bundled schemas, Python 3.15.2 and Node 26.13.1.
CI installs the same ACS source commit with Python 3.12; the hosted CI run itself
has not been observed. The existing Python example-Guardian pin and vendored
schema pin remain `db457a84393bd80954c9b70b2271a719bf7c61cd`; this is a separate
test dependency, not a silent schema upgrade.

## Run locally

Use Python 3.11 or newer and the repository's installed development dependencies.
The test dependency stays outside this package; no Python dependency reaches its
published runtime.

```bash
lab=$(mktemp -d)
python3 -c 'import sys; assert sys.version_info >= (3, 11)'
python3 -m venv "$lab/capture"
"$lab/capture/bin/pip" install \
  "git+https://github.com/GenAI-Security-Project/agent-control-standard@02b24e7c1398794957f8b54ceed0c8a54292706f#subdirectory=adapters"
export ACS_CAPTURE_PYTHON="$lab/capture/bin/python"
```

Without `ACS_CAPTURE_PYTHON`, the new tests skip. Setting it to an unusable Python,
missing upstream package or invalid schema environment fails rather than skips.
CI installs a separate pinned environment and sets the variable before `npm run check`,
so the new tests are required there. The fixture server uses an ephemeral loopback
port, synthetic input and a public test key; it is not a policy engine or a deployment.

## Reference-test comparison

This is a source-level coverage comparison, not execution of upstream's whole suite
against our implementation. Paths prefixed `A/` refer to upstream
[`adapters/tests/`](https://github.com/GenAI-Security-Project/agent-control-standard/tree/02b24e7c1398794957f8b54ceed0c8a54292706f/adapters/tests);
`H/` refers to
[`reference-implementations/agt/packages/host-adapter/test/`](https://github.com/GenAI-Security-Project/agent-control-standard/tree/02b24e7c1398794957f8b54ceed0c8a54292706f/reference-implementations/agt/packages/host-adapter/test).
Those suites import upstream code, so simply running them would not test this adapter.

| Area | Existing local evidence | Remaining gap or distinction |
| --- | --- | --- |
| Response binding | `test/client.test.ts` plus `test/client-boundaries.test.ts`: re-signed wrong ACS `request_id`, wrong hello/error JSON-RPC IDs, contradictory result/error envelopes | These negatives verify the fixture signature before delivery, separating binding/schema rejection from bad-signature rejection. |
| Deadlines | `test/client-boundaries.test.ts`: real stalled/dripping HTTP bodies and default/per-method/explicit deadline precedence | Prompt headers do not end the total response deadline. Timing checks have margins, not a real-time scheduling guarantee. |
| Failure posture | Client and host-handler tests distinguish refusal/integrity from availability; real-host startup refusal test | Main local policy matrix covered. More HTTP/signature combinations are possible. Guardian-tighten-only is explicit local policy. |
| Negotiated methods | Host-handler tests skip unevaluated methods without creating dangling result references | Compact negative-ServerHello matrix still useful; compare `A/common/test_methods_evaluated.py`. Do not advertise extra hooks to match another host. |
| Emissions | New CaptureGuardian runtime cases and existing parallel-call tests | Only the flows listed above have new independent emission evidence. |
| Crypto | `test/crypto.test.ts` and `test/fixtures/signing-vectors.json`: fixed request/result/error canonical inputs and independent HMAC answers, tampering and nonmutation checks | Approved hardening now rejects equivalent-byte Base64 aliases; fixed canonical vectors still pass. See [the hardening decision](enforcement-boundaries.md#base64-policy). |

| MODIFY | Enforcer and extension tests prove a rejected mixed-validity override leaves the original unchanged; real-host modified Bash execution remains covered | Rich redaction/path operations stay unsupported. |
| ASK/DEFER | `test/extension.test.ts`: approval/rejection, UI throw/rejection, timeout dispositions, unsupported routes, and bounded DEFER fallback | Unit tests with fake time; not a real interactive UI certification. Upstream response-expiry semantics and Pi's interactive timer are not identical. |
| Audit failure | `test/audit.test.ts` checks unwritable-file fallback, text omission and counts | Stderr fallback is not durable delivery. Upstream's deny-on-unauditable-proceed behavior is not automatically a requirement to copy. |
| Result enforcement | Four real-host cases exercise DENY/MODIFY after Bash exit 0/1, inspecting the next model request and saved JSONL separately | Original output marker is absent and exact replacement present in both. No streamed-UI or arbitrary-secrecy claim; see [the evidence](enforcement-boundaries.md). |

Run the focused cases from this repository:

```bash
npx vitest run test/upstream-capture.test.ts test/pi-runtime.e2e.test.ts
npm run check
npm run lint
```

## Follow-up priorities and limits

The three original priorities are now covered by the [enforcement-boundary follow-up](enforcement-boundaries.md). The subsequently approved canonical Base64 hardening is now implemented in both adapters.

The initial emission pass changed no adapter source; the approved follow-up hardens signature acceptance. Supported-method lists and conformance claims are unchanged. Tests do not
cover all Pi entry points, direct-shell containment, real-model reliability, full
policy semantics or ACS-Core deployment conformance. Upstream's broader ledger is
still [issue #33](https://github.com/GenAI-Security-Project/agent-control-standard/issues/33).
