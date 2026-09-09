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

  it.each([
    [{ mode: "enforce", guardian: { url: "http://127.0.0.1:8787", hmacKeyEnv: "KEY", keyId: "id" } }, "startupPosture"],
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
