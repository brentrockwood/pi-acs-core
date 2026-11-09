# Security model

This extension is a policy adapter inside Pi's process. It is not a sandbox or an authorization boundary outside that process.

## What it can mediate

In enforcement mode, the adapter waits for a Guardian before Pi executes model-initiated tools routed through `tool_call`. It can block the call or replace validated top-level arguments on the same mutable input object Pi then executes. It also gates ordinary user input, tool-result content before model ingestion, and finalized assistant-message storage at the Pi events listed in [docs/coverage.md](docs/coverage.md).

## What remains outside the boundary

- direct user shell commands entered with Pi's `!` or `!!` path;
- actions performed by another extension without going through Pi's tool event;
- provider-side behavior before Pi receives the model response;
- text already streamed to an interactive terminal before `message_end`;
- operating-system, container, filesystem, network, or account permissions;
- MCP wire traffic before it becomes a normalized Pi tool call;
- a malicious or compromised Pi process, Guardian, extension, dependency, or operator account.

Use operating-system and service-side controls for consequences that must remain secure when Pi or this extension is bypassed.

## Guardian trust

The Guardian decides what Pi is allowed to do, so its endpoint and key configuration are trusted code-equivalent inputs. The extension reads only an explicitly selected `PI_ACS_CONFIG` file or the global `~/.pi/agent/acs-core.json`; it does not silently accept project-local policy configuration.

Enforcement mode requires HMAC-SHA256 and refuses cleartext HTTP except for loopback hosts. HTTPS protects payload confidentiality in transit; the HMAC authenticates the ACS envelope. Use at least 32 UTF-8 bytes from a cryptographically secure random source, not a passphrase. Length is checked; randomness cannot be checked. Keep the shared key in the environment variable named by `hmacKeyEnv`, rotate it as deployment policy requires, and never commit it to configuration or logs.

HMAC is symmetric: either endpoint can create a valid record. It is not non-repudiation.

## Failure posture

A failed Guardian exchange is resolved by what failed, not only by the configured posture. The pinned specification distinguishes a Guardian that answered from one that did not (§4.1, §6.4). This adapter applies the split the maintainers set out on upstream issue #32 on 2026-11-04 and 2026-11-05 as documented local policy:

- **No usable answer** follows the configured posture: a silent Guardian past the timeout, a connection or TLS failure, an HTTP 408 or 5xx without a JSON-RPC body, or an authenticated `-32603` internal error.
- **A refusal blocks under either posture**: any authenticated JSON-RPC error other than `-32603`, including `SESSION_REFUSED`, `UNSUPPORTED_VERSION` and `PROVENANCE_REQUIRED`, and any other HTTP 4xx without a JSON-RPC body. A JSON-RPC error carried on a non-2xx status is read and verified before the status is used.
- **An integrity failure blocks under either posture**: a missing or invalid signature, an unexpected key label, a JSON-RPC id or `request_id` mismatch, a malformed or oversized response (a malformed `allow` included), an unsupported decision, or a request this adapter could not form validly.

`startupPosture` applies to a handshake that gets no usable answer and must be explicit in enforcement mode. `refuse` blocks later input and model tool calls that the extension can mediate; `proceed` starts unguarded and records `acs_session_unguarded`. A handshake refusal or an unverifiable handshake refuses the session under either value and records `acs_startup_refused`; the refused session also withholds user input at Pi's `input` event. After a successful handshake, the Guardian's `on_decision_failure` applies to steps that get no usable answer: `deny` fails closed; `proceed` fails open and records `acs_fail_open`. Observe mode never blocks.

Two consequences deserve a direct statement. A request payload above the advertised 1 MiB limit is a local request fault: the Guardian never sees it, so in enforce mode the step blocks under either posture, where it previously failed open under `proceed`. A success body on a failure status is contradictory and is treated as an integrity failure rather than honored. Host-handler records label a non-adapter error's `failure_kind` as `other`, not `transport`.

The default posture is unchanged by this classification. The upstream proposal to make `deny` the default and to let a Guardian only tighten the local choice has not merged; adopting it is a separate deployment decision. Every failed exchange is audited under either posture with its failure class, its disposition (`availability`, `refusal` or `integrity`) and, when present, the JSON-RPC error code or HTTP status.

The audit sink does not change the Guardian verdict. Without a file path, decision failures go to stderr; a failed file write also falls back to stderr. Operators must capture that stream. Durable audit before execution requires a stronger sink and is outside this alpha's claims.

## Logs and sensitive data

ACS requests may contain prompts, file contents, commands, paths, tool output, and images. The Guardian receives those fields by design. Review its retention and access controls.

Local JSONL audit records replace `payload` with `[omitted]` by default. `includePayloads: true` writes sensitive request and response bodies in plaintext and should be treated accordingly. Files are created with mode `0600`, subject to platform and existing-file behavior.

## Modification safety

Modification is disabled by default. Set `enableModify: true` only after the Guardian's supported modification shapes and the affected Pi tools have been tested together. A Guardian `MODIFY` decision fails closed while modification is disabled.

The adapter reconstructs a complete candidate argument object, validates it against Pi's registered tool schema, and only then replaces the original input. Unsupported redactions, conflicting modification shapes, missing tool schemas, and invalid candidates block rather than partially apply.

Schema validation does not prove semantic safety. A string can satisfy a tool schema and still be destructive; that is the Guardian policy's job.

## Reporting a vulnerability

Do not include secrets, private prompts, or exploit data from third parties in a public issue. Open a minimal GitHub issue asking for a private contact channel, or use GitHub's private vulnerability reporting if it is enabled for the repository.

Audit message text is omitted along with payloads unless file payload logging is explicitly enabled. Stderr fallback always omits both, including when an opted-in file sink fails. Failure class, kind and correlation IDs remain available.
