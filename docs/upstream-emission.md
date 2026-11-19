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
| Response binding | `test/client.test.ts`: signed/unsigned/tampered hello, key labels, refusal signatures, JSON-RPC ID mismatch | Add independently signed wrong ACS `request_id` and contradictory-response cases; `A/core/test_response_binding.py` is the reference. Source checks are not equivalent to negative-test coverage. |
| Deadlines | `test/client.test.ts`: negotiated default timeout | No dedicated real stalled/dripping response-body or per-method timeout-precedence test. Compare `A/client/test_exchange.py`, `OverallDeadline`. |
| Failure posture | Client and host-handler tests distinguish refusal/integrity from availability; real-host startup refusal test | Main local policy matrix covered. More HTTP/signature combinations are possible. Guardian-tighten-only is explicit local policy. |
| Negotiated methods | Host-handler tests skip unevaluated methods without creating dangling result references | Compact negative-ServerHello matrix still useful; compare `A/common/test_methods_evaluated.py`. Do not advertise extra hooks to match another host. |
| Emissions | New CaptureGuardian runtime cases and existing parallel-call tests | Only the flows listed above have new independent emission evidence. |
| Crypto | `test/crypto.test.ts`: HKDF known answer, exact session-ID bytes, wrong-session and legacy keys; new independent capture verifier | Exact signed request/result/error vectors remain useful. Upstream `A/core/test_signing_vectors.py` rejects noncanonical Base64 spellings; our verifier compares decoded bytes and is more permissive. This difference needs a protocol/policy decision, not an unannounced verifier change. |

| MODIFY | `test/enforcer.test.ts` and real-host modified Bash execution | Need an explicit rejected mixed-validity modification leaves the original unchanged test. Rich redaction/path operations stay unsupported; compare `H/modifications.test.ts`. |
| ASK/DEFER | `test/extension.test.ts` confirms an approved human ASK; source implements other branches | Rejection, UI failure, timeout/default and DEFER fallback need focused tests. Upstream response-expiry semantics and Pi's interactive timer are not identical. |
| Audit failure | `test/audit.test.ts` checks unwritable-file fallback, text omission and counts | Stderr fallback is not durable delivery. Upstream's deny-on-unauditable-proceed behavior is not automatically a requirement to copy. |
| Result enforcement | Unit hook tests replace denied results/final assistant content | Need real-host proof of text received by the next model request and saved transcript. New emission tests check result acceptance/correlation, not confidentiality or output preservation. |

Run the focused cases from this repository:

```bash
npx vitest run test/upstream-capture.test.ts test/pi-runtime.e2e.test.ts
npm run check
npm run lint
```

## Follow-up priorities and limits

1. Add real stalled-body and per-method-deadline regression tests.
2. Add fixed signing/binding vectors; decide canonical Base64 policy before tightening it.
3. Test real Pi result withholding, then the untested ASK/DEFER and modification-failure branches.

No adapter source, supported-method list or conformance claim changed. Tests do not
cover all Pi entry points, direct-shell containment, real-model reliability, full
policy semantics or ACS-Core deployment conformance. Upstream's broader ledger is
still [issue #33](https://github.com/GenAI-Security-Project/agent-control-standard/issues/33).
