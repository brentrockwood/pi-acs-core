import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";

describe("configuration", () => {
  it("loads a strict signed enforcement configuration", () => {
    const config = parseConfig({
      mode: "enforce",
      startupPosture: "refuse",
      guardian: {
        url: "http://127.0.0.1:8787",
        hmacKeyEnv: "PI_ACS_KEY",
        keyId: "local",
      },
    }, "/work");
    expect(config.guardian.url).toBe("http://127.0.0.1:8787/");
    expect(config.guardian.connectTimeoutMs).toBe(2_000);
    expect(config.audit.includePayloads).toBe(false);
    expect(config.enableModify).toBe(false);
  });

  it("defaults both postures to fail-safe and lets only local configuration opt into fail-open", () => {
    const guardian = { url: "http://127.0.0.1:8787", hmacKeyEnv: "KEY", keyId: "id" };
    expect(parseConfig({ mode: "enforce", guardian }, "/work"))
      .toMatchObject({ startupPosture: "refuse", decisionFailurePosture: "deny" });
    expect(parseConfig({ guardian: { url: guardian.url } }, "/work"))
      .toMatchObject({ mode: "observe", startupPosture: "refuse", decisionFailurePosture: "deny" });
    expect(parseConfig({ mode: "enforce", startupPosture: "proceed", guardian }, "/work"))
      .toMatchObject({ startupPosture: "proceed", decisionFailurePosture: "proceed" });
    expect(parseConfig({ mode: "enforce", startupPosture: "refuse", decisionFailurePosture: "proceed", guardian }, "/work"))
      .toMatchObject({ startupPosture: "refuse", decisionFailurePosture: "proceed" });
    expect(parseConfig({ mode: "enforce", startupPosture: "proceed", decisionFailurePosture: "deny", guardian }, "/work"))
      .toMatchObject({ startupPosture: "proceed", decisionFailurePosture: "deny" });
  });

  it.each([
    [{ guardian: { url: "http://127.0.0.1:8787" }, startupPosture: "deny" }, "startupPosture"],
    [{ guardian: { url: "http://127.0.0.1:8787" }, decisionFailurePosture: "refuse" }, "decisionFailurePosture"],
    [{ mode: "enforce", startupPosture: "refuse", guardian: { url: "http://127.0.0.1:8787" } }, "hmacKeyEnv"],
    [{ mode: "enforce", startupPosture: "refuse", guardian: { url: "http://guardian.example", hmacKeyEnv: "KEY", keyId: "id" } }, "https"],
    [{ guardian: { url: "file:///tmp/socket" } }, "http or https"],
    [{ guardian: { url: "http://127.0.0.1", timeout: 1 } }, "unknown key"],
    [{ guardian: { url: "http://127.0.0.1", connectTimeoutMs: 0 } }, "positive integer"],
    [{ guardian: { url: "http://127.0.0.1" }, enableModify: "yes" }, "enableModify"],
  ])("rejects invalid configuration", (value, message) => {
    expect(() => parseConfig(value, "/work")).toThrow(message);
  });
});
