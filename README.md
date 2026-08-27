# Pi ACS adapter

An experimental [Agent Control Standard](https://agentcontrolstandard.org/) v0.1 adapter for the [Pi coding agent](https://pi.dev/).

The extension puts a Guardian decision point around Pi's ordinary model-initiated tool calls. It can also send user messages, tool results, finalized assistant responses, and session lifecycle events through the ACS wire format. Requests and responses are checked against a pinned copy of the canonical JSON schemas before the adapter acts on them.

This is an independent early implementation. It is not an official OWASP integration, is not published to npm, and does not yet claim the `acs-core` conformance profile. The exact gap is documented in [the coverage matrix](docs/coverage.md).

## What works now

- ACS `handshake/hello` over HTTP or HTTPS
- offline validation against ACS v0.1.0 schemas pinned at commit [`c7ad162`](https://github.com/GenAI-Security-Project/agent-control-standard/commit/c7ad162f69386daac94b89073e3b751e8cdf28b2)
- per-session HMAC-SHA256 request and response authentication
- Guardian ALLOW and DENY enforcement before Pi executes a tool
- schema-validated `parameter_overrides` applied to the same mutable Pi input object that executes
- human ASK through Pi's confirmation UI
- bounded DEFER timeout handling
- tool-result blocking or wholesale text replacement before the result returns to the model
- optional JSONL audit output, with payload bodies omitted by default
- explicit fail-open or fail-closed startup behavior

It does not sandbox Pi, mediate direct user shell commands, prevent already-streamed assistant text from appearing, wrap MCP traffic at the protocol layer, or provide an OWASP endorsement. Read [SECURITY.md](SECURITY.md) before using enforcement mode.

## Try it from this repository

Requirements: Node.js 22 or newer, Pi 0.84.3, and a local checkout of this repository.

```sh
npm install
npm run check
export PI_ACS_DEMO_KEY='local-demo-only'
npm run demo:guardian
```

In another terminal:

```sh
export PI_ACS_DEMO_KEY='local-demo-only'
export PI_ACS_CONFIG="$PWD/examples/config.json"
pi -e ./src/index.ts
```

Ask Pi to run commands containing these marker strings:

- `acs-deny` — the demo Guardian denies the tool call.
- `acs-rewrite` — it replaces the command with a harmless `printf`.
- `acs-malformed` — it returns invalid JSON so the adapter exercises fail-closed behavior.
- `acs-delay` — it waits longer than the configured timeout.

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

Enforcement mode requires an explicit startup posture and HMAC configuration. Non-loopback Guardians must use HTTPS. `observe` mode reports Guardian decisions but does not apply them.

Inside Pi, `/acs-status` shows the negotiated methods and `/acs-ping` runs the unsigned liveness probe required by the standard.

Remove the package with:

```sh
pi remove git:github.com/brentrockwood/pi-acs-core
```

## Protocol choices

The ACS text requires a per-session HMAC key but does not prescribe exact HKDF salt and info bytes. This adapter uses:

- input key material: UTF-8 bytes from the configured environment variable
- salt: UTF-8 ACS `session_id`
- info: UTF-8 `pi-acs-core/v0.1.0/HMAC-SHA256`
- output: 32 bytes using HKDF-SHA256
- signature input: JCS-canonicalized envelope with its signature field removed

A Guardian must use the same derivation. These byte choices are this adapter's interoperability contract, not a claim about wording absent from ACS v0.1.

## Development

```sh
npm ci
npm run check
npm audit --omit=dev
```

The suite covers schema rejection, strict configuration, signed correlation, transport failures, tool denial, exact-object modification, human ASK, parallel tool-result correlation, and payload-off audit records. A local pre-commit hook scans staged content with TruffleHog; enable it with `git config core.hooksPath .githooks` after cloning.

Apache-2.0. The vendored ACS schemas retain their upstream license and notice; see [vendor/acs/UPSTREAM.md](vendor/acs/UPSTREAM.md).
