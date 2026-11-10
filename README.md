# Pi ACS adapter

An experimental [Agent Control Standard](https://agentcontrolstandard.org/) v0.1 adapter for the [Pi coding agent](https://pi.dev/).

The extension puts a Guardian decision point around Pi's ordinary model-initiated tool calls. It can also send user messages, tool results, finalized assistant responses, and session lifecycle events through the ACS wire format. Requests and responses are checked against a pinned copy of the canonical JSON schemas before the adapter acts on them.

This is an independent early implementation. It is not an official OWASP integration, is not published to npm, and does not yet claim the `acs-core` conformance profile. The exact gap is documented in [the coverage matrix](docs/coverage.md).

## What works now

- ACS `handshake/hello` over HTTP or HTTPS
- offline validation against ACS v0.1.0 schemas pinned at integration commit [`db457a8`](https://github.com/GenAI-Security-Project/agent-control-standard/commit/db457a84393bd80954c9b70b2271a719bf7c61cd); see [vendor/acs/UPSTREAM.md](vendor/acs/UPSTREAM.md)
- per-session HMAC-SHA256 request and response authentication
- Guardian ALLOW and DENY enforcement before Pi executes a tool
- opt-in, schema-validated `parameter_overrides` applied to the same mutable Pi input object that executes
- human ASK through Pi's confirmation UI
- bounded DEFER timeout handling
- tool-result blocking or wholesale text replacement before the result returns to the model
- optional JSONL audit output, with payload bodies omitted by default
- explicit fail-open or fail-closed behavior for a Guardian that gives no usable answer; signed refusals and verification failures block under either posture

It does not sandbox Pi, mediate direct user shell commands, prevent already-streamed assistant text from appearing, wrap MCP traffic at the protocol layer, or provide an OWASP endorsement. Read [SECURITY.md](SECURITY.md) before using enforcement mode.

## Try it from this repository

Requirements: Node.js 22 or newer, Pi 0.84.3, and a local checkout of this repository.

```sh
npm install
npm run check
export PI_ACS_DEMO_KEY='local-demo-only-not-for-production-32-bytes'
npm run demo:guardian
```

In another terminal:

```sh
export PI_ACS_DEMO_KEY='local-demo-only-not-for-production-32-bytes'
export PI_ACS_CONFIG="$PWD/examples/config.json"
pi -e ./src/index.ts
```

Ask Pi to run commands containing these marker strings:

- `acs-deny` — the demo Guardian denies the tool call.
- `acs-rewrite` — it replaces the command with a harmless `printf`.
- `acs-malformed` — it returns invalid JSON so the adapter exercises fail-closed behavior.
- `acs-refuse` — it returns a signed JSON-RPC refusal, which blocks under either failure posture.
- `acs-delay` — it waits longer than the configured timeout, which follows the negotiated posture.

The demo Guardian is a fixture, not a policy engine. Its shared key is deliberately local and disposable.

## Install from GitHub

There is no release tag yet. For development use:

```sh
pi install git:github.com/brentrockwood/pi-acs-core
```

Create `~/.pi/agent/acs-core.json`, or set `PI_ACS_CONFIG` to an explicit configuration path. The environment variable named by `hmacKeyEnv` must contain the shared deployment key. The key itself does not belong in JSON.

```json
{
  "mode": "enforce",
  "startupPosture": "refuse",
  "decisionFailurePosture": "deny",
  "enableModify": false,
  "guardian": {
    "url": "https://guardian.example/acs",
    "connectTimeoutMs": 2000,
    "maxResponseBytes": 1048576,
    "hmacKeyEnv": "PI_ACS_HMAC_KEY",
    "keyId": "pi-production"
  },
  "audit": {
    "path": "/var/tmp/pi-acs-events.jsonl",
    "includePayloads": false
  },
  "agent": {
    "id": "pi-coding-agent",
    "environment": "production"
  }
}
```

Both failure postures default to fail-safe. `startupPosture` (default `refuse`) applies to a handshake that gets no usable answer. `decisionFailurePosture` (default `deny`, or `proceed` when `startupPosture` is `proceed`) applies to a later step that gets no usable answer. Only this local configuration can opt into fail-open with `proceed`: the Guardian's negotiated `on_decision_failure` can tighten the local choice to `deny` but cannot loosen it, and a Guardian that omits the field leaves the local value in force. A verified refusal or an unverifiable answer blocks under either value. Enforcement mode requires HMAC configuration. Non-loopback Guardians must use HTTPS. `observe` mode reports Guardian decisions but does not apply them. Guardian `MODIFY` decisions are applied only when `enableModify` is explicitly `true`; otherwise they fail closed.

Inside Pi, `/acs-status` shows the negotiated methods and `/acs-ping` runs the unsigned liveness probe required by the standard.

Remove the package with:

```sh
pi remove git:github.com/brentrockwood/pi-acs-core
```

## Protocol choices

Session keys follow merged ACS §10:

- input key material: UTF-8 bytes from the configured environment variable
- salt: empty
- info: the exact transmitted ACS `session_id` string, encoded as UTF-8 without normalization
- output: 32 bytes using HKDF-SHA256
- signature input: JCS-canonicalized envelope with its signature field removed

The configured secret must contain at least 32 UTF-8 bytes from a cryptographically secure random source, not a passphrase. Configuration remains literal UTF-8 text: base64-looking values are not decoded. `keyId` remains the configured opaque label.

Upgrade adapters and Guardians together: the previous adapter-specific derivation is no longer accepted, and there is no fallback. The fixed demo key above is for local testing only.

## Development

```sh
npm ci
npm run check
npm audit --omit=dev
```

The suite covers schema rejection, strict configuration, signed correlation, transport failures, tool denial, exact-object modification, human ASK, parallel tool-result correlation, and payload-off audit records. Its black-box end-to-end test launches the pinned Pi CLI with this extension, a deterministic local model fixture, and a loopback HTTP Guardian. It proves that Pi's real Bash tool executes an allowed command, does not execute a denied command, and executes Guardian-modified arguments instead of the model's original arguments. It requires no model credentials or external network access.

Run that test alone with `npm run test:e2e`. It is also included in `npm test` and CI. A local pre-commit hook scans staged content with TruffleHog; enable it with `git config core.hooksPath .githooks` after cloning.

An interoperability suite, `test/guardian-interop.e2e.test.ts`, drives the client against the upstream Python example Guardian from specification commit `db457a8`. It runs when `ACS_UPSTREAM_GUARDIAN` names that executable and is skipped otherwise; CI installs it from that commit. Locally:

```sh
python3 -m venv .guardian && .guardian/bin/pip install "git+https://github.com/GenAI-Security-Project/agent-control-standard@db457a84393bd80954c9b70b2271a719bf7c61cd#subdirectory=adapters"
```

```sh
ACS_UPSTREAM_GUARDIAN=$PWD/.guardian/bin/acs-example-guardian npm test
```

The recorded evidence and observations are in [docs/coverage.md](docs/coverage.md).

Apache-2.0. The vendored ACS schemas retain their upstream license and notice; see [vendor/acs/UPSTREAM.md](vendor/acs/UPSTREAM.md).

### Decision-failure audit

Failed exchanges are recorded under both failure postures and counted per session in `summary.decision_failures` at session end. Without `audit.path`, these records go to stderr; failed file writes also fall back to stderr. Capture that stream if no writable audit file is configured. Audit delivery does not change enforcement and is not guaranteed durable.

Audit message text is omitted along with payloads unless file payload logging is explicitly enabled. Stderr fallback always omits both, including when an opted-in file sink fails. Failure class, kind and correlation IDs remain available.
