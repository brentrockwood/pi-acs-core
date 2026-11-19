# Go Guardian interoperability — 2026-11-18

The Pi adapter worked with OWASP ACS's merged Go Guardian and its real AGT runtime without an adapter source change. Six optional tests cover the wire and the pinned Pi CLI. They are a bounded interoperability check, not an ACS-Core conformance claim or a policy-security evaluation.

## Baseline and result

| Component | Tested revision/version |
| --- | --- |
| Pi adapter source | `8c8126bc6495f6342edb997e7d688ae8fa0cb83e` plus the two new test files |
| Pi CLI | `0.84.3` |
| ACS repository | `02b24e7c1398794957f8b54ceed0c8a54292706f` (`integration`, November 18) |
| Go Guardian merge | [PR #169](https://github.com/GenAI-Security-Project/agent-control-standard/pull/169), November 17 |
| AGT source | `81955d48025c6b11deb3fc9dabf89f74f4145775` |
| AGT runtime / Rust / OPA | `0.3.1-beta.0` / `1.99.0` / `0.70.0` |
| Local build/runtime | macOS arm64; Go `1.27.4`; Node `26.13.1`; Bun `1.3.14` |

The Guardian used its unchanged `guardian.yaml` and stock AGT manifest/mapping, with environment overrides only for a loopback ephemeral port, test key and temporary log paths. No policy aliases or policy edits were needed for Pi's `bash` tool. A fresh random 32-byte value was hex-encoded to 64 ASCII characters: Pi used those UTF-8 bytes, and the Guardian's file contained their base64 encoding. The key label on both sides was `go-interop-key`. Hex-decoding the text on one side would produce a different secret.

`test/go-guardian-interop.e2e.test.ts` establishes:

- The adapter validates the signed direct ServerHello, ACS version, HTTP transport and method negotiation. Go returns the six offered step hooks, excluding `system/ping`; an explicit unsigned ping succeeds without creating a chain head.
- Signed session start, benign tool call, linked clean tool result and session end are accepted. A tool-call decision with reason `destructive_shell_command_blocked` is denied. Step heads change and the client retains the last received head; this suite does not independently recompute the chain.
- A request with an all-zero HMAC gets `SIGNATURE_INVALID` (`-32004`) and no decision.
- Changing a real Guardian response after signing makes the adapter report an integrity failure. This test sets the local and in-memory negotiated failure postures to `proceed` to isolate the integrity rule; it does not claim the Guardian negotiated that posture.

`test/go-guardian-runtime.e2e.test.ts` starts the installed, pinned Pi CLI with this adapter and a deterministic loopback model server:

- ALLOW produces the expected file in the test's own temporary directory. The client audit records signed, correlated tool-call and tool-result decisions and successful tool completion.
- DENY prevents the file write, records the signed policy denial and correlated tool block, and does not record tool completion. The candidate command is harmless `printf`; the text `rm -rf /` appears **only in a shell comment** to trigger the stock text-matching rule. No destructive command is executed.
- Both cases require a completed model conversation and no startup or decision failures, so refusing every session cannot make the deny case pass.

The first run passed five cases and failed one test expectation: it expected `system/ping` in `methods_evaluated`, as the Python example advertises. Inspection confirmed Go dispatches liveness separately. The test now expects the six evaluated step hooks and checks ping directly. No adapter behavior was changed to accommodate this.

The full adapter check with the Go suites enabled passed **117 tests**, with **11 Python-Guardian tests skipped** because `ACS_UPSTREAM_GUARDIAN` was not set. Typechecking is part of that check. The Go tests are opt-in and skip when `ACS_GO_GUARDIAN_URL` is absent; they are not installed or started by ordinary CI.

## Reproduce

Prerequisites: the Pi checkout's installed development dependencies (including pinned Pi), Go 1.27.4+, a C compiler, Make, Git, curl, jq, OpenSSL and an existing rustup executable. The first build downloads the pinned Rust toolchain, AGT sources, Go/Cargo dependencies and OPA. The following uses temporary toolchain/cache directories rather than changing the user's Rust installation.

From the Pi repository root, in a Bash shell:

```bash
set -eu
adapter=$PWD
lab=$(mktemp -d /tmp/acs-go-lab.XXXXXX)
umask 077
rustup_bin=$(command -v rustup || printf '%s' "$HOME/.cargo/bin/rustup")
test -x "$rustup_bin"
mkdir -p "$lab/cargo/bin"
cp "$rustup_bin" "$lab/cargo/bin/rustup"
for tool in cargo rustc rustdoc; do ln -s rustup "$lab/cargo/bin/$tool"; done
export CARGO_HOME="$lab/cargo" RUSTUP_HOME="$lab/rustup"
export GOPATH="$lab/go" GOCACHE="$lab/go-cache"
export PATH="$CARGO_HOME/bin:$PATH"
git clone https://github.com/GenAI-Security-Project/agent-control-standard.git "$lab/upstream"
git -C "$lab/upstream" checkout --detach 02b24e7c1398794957f8b54ceed0c8a54292706f
module="$lab/upstream/reference-implementations/agt-go"
(cd "$module" && make build) > "$lab/build.log" 2>&1
platform="$(go env GOHOSTOS)-$(go env GOHOSTARCH)"
bin="$module/.acs/bin/$platform/agt/acs-guardian"

# Encode the UTF-8 text, NOT the bytes obtained by hex-decoding it.
export PI_ACS_GO_INTEROP_KEY=$(openssl rand -hex 32)
printf '%s' "$PI_ACS_GO_INTEROP_KEY" | openssl base64 -A > "$lab/hmac-secret"
# Use a shell without unrelated ACS__ environment overrides.
ACS__SERVER__HOST=127.0.0.1 ACS__SERVER__PORT=0 \
ACS__SECURITY__HMAC_KEY_ID=go-interop-key \
ACS__SECURITY__HMAC_SECRET_FILE="$lab/hmac-secret" \
ACS__AUDIT__ENVELOPE_LOG="$lab/envelopes.jsonl" \
ACS__AUDIT__EVENT_LOG="$lab/guardian-events.jsonl" \
"$bin" --config "$module/guardian.yaml" > "$lab/guardian.log" 2>&1 &
guardian_pid=$!
trap 'kill "$guardian_pid" 2>/dev/null || true; wait "$guardian_pid" 2>/dev/null || true' EXIT
```

Wait for `Guardian listening at http://127.0.0.1:<port>/acs` in `$lab/guardian.log`. Set the URL to that exact address, then run:

```bash
export ACS_GO_GUARDIAN_URL='http://127.0.0.1:<port>/acs'
curl --fail "${ACS_GO_GUARDIAN_URL%/acs}/readyz"
cd "$adapter"
npx vitest run test/go-guardian-interop.e2e.test.ts test/go-guardian-runtime.e2e.test.ts
# Full regression check, with the same environment:
npm run check
npm run lint
kill "$guardian_pid"
wait "$guardian_pid"
trap - EXIT
unset PI_ACS_GO_INTEROP_KEY ACS_GO_GUARDIAN_URL
```

Use a real port number in place of `<port>`. Both test files refuse non-loopback or non-HTTP endpoints. Keep the native library and `agt-native.json` beside the built binary. Preserve the lab directory if investigating a failure; it contains raw synthetic envelopes and the disposable test secret. Do not commit it.

## Limits

- This run tests only Pi 0.84.3, not newer hosts or the OpenCode adapter. The model is a deterministic local fixture, not an external model.
- The result test verifies clean-result acceptance and request correlation, not preservation of output text through the model. Redaction/MODIFY, ASK/DEFER, wrapped MCP, restart persistence, concurrent-session load and full chain reconstruction were not tested against Go.
- AGT's shipped policies are protocol demonstrations. A hook may be accepted and recorded without a configured policy gate. The comment-triggered denial proves enforcement of that rule, not shell-command understanding or containment.
- The pinned Guardian predates the proposed fixes in [PR #619](https://github.com/GenAI-Security-Project/agent-control-standard/pull/619) for [issue #612](https://github.com/GenAI-Security-Project/agent-control-standard/issues/612). These smoke tests do not cover those findings.
- No production service, configuration, dependency manifest or adapter source was changed. No upstream quality-gate or production-readiness claim follows from a successful build and these tests.
