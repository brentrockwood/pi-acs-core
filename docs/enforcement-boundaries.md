# Enforcement-boundary evidence — 2026-11-19

Follow-up to the [upstream emission comparison](upstream-emission.md). Pi remains pinned to **0.84.3**. The later approved hardening changes are included below; dependencies and host versions are unchanged.

## Shared protocol regressions

Each repository carries its own tests and fixtures; neither imports its sibling.

- `test/client-boundaries.test.ts` adds 13 cases. Real loopback HTTP sends headers promptly, then stalls or drips the body. Both remain bounded by the overall deadline. Default, per-method and explicit timeout precedence are exercised, including successful responses inside the deadline.
- Binding negatives re-sign the changed envelope and verify the fixture signature before delivery. A wrong ACS `request_id`, wrong hello/error JSON-RPC ID, and contradictory `result` plus `error` are rejected as correlation/schema failures, not accepted or mistaken for availability failures.
- `test/crypto.test.ts` uses fixed request/result/error canonical inputs and independent HMAC answers from `test/fixtures/signing-vectors.json`. It checks tampering, wrong keys, malformed MAC lengths and nonmutation. The fixture records upstream input provenance and the independent Python calculation for result/error answers.
- Rejected mixed-validity MODIFY tests assert that the original arguments stay unchanged.

The initial regression cases passed against existing production code. The subsequently approved Base64 hardening and OpenCode result gate are implementation changes, not a conformance claim.

## Base64 policy

The verifier now requires the signature value to equal its standard Base64 decode/re-encode result before comparing MAC bytes. Tests reject equivalent-byte aliases: nonzero pad bits, extra/missing padding, embedded whitespace/nonalphabet characters, and alternate Base64url spellings. This is an explicitly approved hardening change for upstream parity. No HMAC forgery was demonstrated by the previously accepted aliases.

At ACS [`02b24e7c1398794957f8b54ceed0c8a54292706f`](https://github.com/GenAI-Security-Project/agent-control-standard/tree/02b24e7c1398794957f8b54ceed0c8a54292706f), specification §10 mandates RFC 8785 canonicalization of the signed envelope input; the signature schema describes a “Base64-encoded signature” without an encoding pattern. Upstream [PR #600](https://github.com/GenAI-Security-Project/agent-control-standard/pull/600) describes canonical Base64 rejection as reference-implementation hardening. [RFC 4648 §3.5](https://www.rfc-editor.org/rfc/rfc4648#section-3.5) requires encoders to zero pad bits but permits decoders to reject nonzero bits. Its §3.3 nonalphabet rules are a separate, stronger concern; optional pad-bit rejection does not justify every permissive spelling.

Brent approved strict canonical Base64 verification in both adapters. Guardians emitting noncanonical signatures must correct their encoding: enforce mode rejects them as integrity failures, even under an availability `proceed` posture. Standard padded Base64 signatures are unchanged. This is local hardening, not a claim that full canonical-spelling rejection is an established ACS MUST.

## Pi decision paths

`test/extension.test.ts` covers human ASK rejection, synchronous UI throws and rejected promises, omitted/deny/allow timeout dispositions, abort-signal delivery and timer cleanup, and schema-valid unsupported routing (`agent`, `service`, custom options and intent extension). Fake-clock DEFER tests establish that the call remains pending at 4,999 ms, then follows the default/deny/ask fallback at 5,000 ms, including approval, rejection and UI failure. These are handler tests, not a real interactive UI test.

## Real-host output withholding

Four `test/pi-runtime.e2e.test.ts` cases run harmless Bash commands through the pinned CLI: DENY and opt-in whole-text MODIFY after exit 0 and exit 1. Each checks the signed decision, the original output and execution status sent to the Guardian, and request/result correlation.

The tests separately inspect:

1. The exact next HTTP model request: original synthetic marker absent; exact block/replacement text present as the tool message.
2. The persisted Pi JSONL: original marker absent; exact replacement and expected tool-result `isError` present.

All four pass. The tool already ran; DENY does not reverse its effects. These checks do not cover streamed UI output, arbitrary third-party tools, or secrecy against reconstruction from command arguments. The marker is split across command arguments to distinguish copied output from the input; a model could still reconstruct it. The Guardian sees the original by design.

## Verification

With both Python oracle environments enabled, `npm run check` passed **169 tests**, with **6 optional Go-Guardian tests skipped** because that server was not running. `npm run lint` passed. The regular runtime suite includes all four new result cases and the upstream capture cases. No new hosted CI run, publication or deployment is claimed.
