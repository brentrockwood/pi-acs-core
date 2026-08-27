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

Enforcement mode requires HMAC-SHA256 and refuses cleartext HTTP except for loopback hosts. HTTPS protects payload confidentiality in transit; the HMAC authenticates the ACS envelope. Keep the shared key in the environment variable named by `hmacKeyEnv`, rotate it as deployment policy requires, and never commit it to configuration or logs.

HMAC is symmetric: either endpoint can create a valid record. It is not non-repudiation.

## Failure posture

`startupPosture` controls a failed handshake and must be explicit in enforcement mode:

- `refuse` blocks later input and model tool calls that the extension can mediate.
- `proceed` starts unguarded and records the bypass if an audit path is configured.

After a successful handshake, the Guardian's `on_decision_failure` controls malformed responses, transport errors, and timeouts. `deny` fails closed; `proceed` fails open and writes an `acs_fail_open` audit event when a sink is configured.

The audit sink is passive. A full disk or permission failure does not change the Guardian verdict and is not currently surfaced to Pi. A deployment that requires durable audit before execution needs a stronger sink and is outside this alpha's claims.

## Logs and sensitive data

ACS requests may contain prompts, file contents, commands, paths, tool output, and images. The Guardian receives those fields by design. Review its retention and access controls.

Local JSONL audit records replace `payload` with `[omitted]` by default. `includePayloads: true` writes sensitive request and response bodies in plaintext and should be treated accordingly. Files are created with mode `0600`, subject to platform and existing-file behavior.

## Modification safety

The adapter reconstructs a complete candidate argument object, validates it against Pi's registered tool schema, and only then replaces the original input. Unsupported redactions, conflicting modification shapes, missing tool schemas, and invalid candidates block rather than partially apply.

Schema validation does not prove semantic safety. A string can satisfy a tool schema and still be destructive; that is the Guardian policy's job.

## Reporting a vulnerability

Do not include secrets, private prompts, or exploit data from third parties in a public issue. Open a minimal GitHub issue asking for a private contact channel, or use GitHub's private vulnerability reporting if it is enabled for the repository.
