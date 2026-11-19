import { afterEach, describe, expect, it, vi } from "vitest";
import { AcsClient } from "../src/client.js";
import { parseConfig } from "../src/config.js";
import { canonicalEnvelope, deriveSessionKey, signEnvelope, verifyEnvelope } from "../src/crypto.js";
import vectors from "./fixtures/signing-vectors.json" with { type: "json" };
import type { AcsRequestEnvelope, AcsResponseEnvelope } from "../src/types.js";

const sessionId = "6b1f2c9e-4d7a-4e3b-8a51-9c0d2e7f1a36";
const secret = Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString("utf8");

describe("§10 HMAC derivation", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("matches the upstream bytes 0–31 known-answer vector", () => {
    expect(deriveSessionKey(secret, sessionId).toString("hex"))
      .toBe("80f0dc8c611279bfc2af2d5f374c5cb685888192ce1af5c3e0673d8fa748e8a4");
  });

  it.each([sessionId.toUpperCase(), `urn:uuid:${sessionId}`, ` ${sessionId} `])(
    "does not normalize the transmitted session ID %s",
    (spelling) => expect(deriveSessionKey(secret, spelling)).not.toEqual(deriveSessionKey(secret, sessionId)),
  );

  it("does not normalize Unicode session IDs", () => {
    expect(deriveSessionKey(secret, "é")).not.toEqual(deriveSessionKey(secret, "e\u0301"));
  });

  it.each(["", "a".repeat(31), "é".repeat(15)])("rejects short UTF-8 key material", (key) => {
    expect(() => deriveSessionKey(key, sessionId)).toThrow("at least 32 UTF-8 bytes");
  });

  it("counts secret bytes rather than characters and preserves UTF-8 text", () => {
    expect(deriveSessionKey("é".repeat(16), sessionId)).toHaveLength(32);
    expect(deriveSessionKey("a".repeat(32), sessionId)).not.toEqual(
      deriveSessionKey(Buffer.from("a".repeat(32)).toString("base64"), sessionId),
    );
  });

  it.each(["a".repeat(31), "é".repeat(15)])("rejects a short configured secret before any request", (key) => {
    vi.stubEnv("ACS_CRYPTO_TEST_KEY", key);
    const config = parseConfig({
      mode: "enforce", startupPosture: "refuse",
      guardian: { url: "http://127.0.0.1:8787/", hmacKeyEnv: "ACS_CRYPTO_TEST_KEY", keyId: "opaque-label" },
    }, "/work");
    expect(() => new AcsClient(config)).toThrow("at least 32 UTF-8 bytes");
  });

  it("accepts a 32-byte multibyte configured secret", () => {
    vi.stubEnv("ACS_CRYPTO_TEST_KEY", "é".repeat(16));
    const config = parseConfig({
      mode: "enforce", startupPosture: "refuse",
      guardian: { url: "http://127.0.0.1:8787/", hmacKeyEnv: "ACS_CRYPTO_TEST_KEY", keyId: "opaque-label" },
    }, "/work");
    expect(new AcsClient(config).signed).toBe(true);
  });

  it("preserves the configured opaque key ID and does not accept another session key", () => {
    const envelope: AcsResponseEnvelope = { jsonrpc: "2.0", id: "1", error: { code: -32600, message: "test" } };
    const key = deriveSessionKey(secret, sessionId);
    const signature = signEnvelope(envelope, key, "deployment/2026-11");
    expect(signature.key_id).toBe("deployment/2026-11");
    expect(verifyEnvelope(envelope, key, signature)).toBe(true);
    for (const legacyKey of [
      "0e0e7812cbf17af4301d12f6c162fd061ab4464fe8af8096a6db8c854e975b11",
      "0dc01474db22bf9ce126115017e9bd95160912355af53d410ad665a4df7f746b",
    ]) {
      const legacySignature = signEnvelope(envelope, Buffer.from(legacyKey, "hex"), signature.key_id);
      expect(verifyEnvelope(envelope, key, legacySignature)).toBe(false);
    }
    expect(verifyEnvelope(envelope, deriveSessionKey(secret, sessionId.toUpperCase()), signature)).toBe(false);
  });
});

// The fixture pins upstream hand-written JCS inputs and independently computed HMACs.
// Its intentionally minimal envelopes exercise crypto, not schema validation.
describe("§10 independent signing vectors", () => {
  const key = Buffer.from(vectors.keyHex, "hex");

  it.each(vectors.vectors)("$name: fixed input, HMAC, verification and nonmutation", (vector) => {
    const envelope = structuredClone(vector.envelope) as unknown as AcsRequestEnvelope | AcsResponseEnvelope;
    const before = structuredClone(envelope);
    const signature = { algorithm: "HMAC-SHA256" as const, key_id: "lab", value: vector.hmac };
    expect(canonicalEnvelope(envelope)).toBe(vector.canonical);
    expect(signEnvelope(envelope, key, "lab")).toEqual(signature);
    // Verification has an independent expected value, not just our signer's output.
    expect(verifyEnvelope(envelope, key, signature)).toBe(true);
    expect(envelope).toEqual(before);

    const container = "params" in envelope ? envelope.params : envelope.result ?? envelope.error!;
    container.signature = signature;
    const signedBefore = structuredClone(envelope);
    expect(canonicalEnvelope(envelope)).toBe(vector.canonical);
    expect(signEnvelope(envelope, key, "lab")).toEqual(signature);
    expect(verifyEnvelope(envelope, key, signEnvelope(envelope, key, "lab"))).toBe(true);
    expect(envelope).toEqual(signedBefore);

    expect(verifyEnvelope(envelope, Buffer.alloc(32, 255), signature)).toBe(false);
    expect(verifyEnvelope({ ...envelope, id: "tampered" }, key, signature)).toBe(false);
    const changedMac = Buffer.from(vector.hmac, "base64");
    changedMac[0] = changedMac[0]! ^ 1;
    expect(verifyEnvelope(envelope, key, { ...signature, value: changedMac.toString("base64") })).toBe(false);
    for (const value of ["", "not base64!", "AA==", Buffer.alloc(33).toString("base64")]) {
      expect(verifyEnvelope(envelope, key, { ...signature, value })).toBe(false);
    }
    expect(envelope).toEqual(signedBefore);
  });

  it.each(vectors.vectors)("$name: rejects noncanonical Base64 aliases", (vector) => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const value = vector.hmac;
    const alias = value.slice(0, -2) + alphabet[alphabet.indexOf(value.at(-2)!) | 3] + "=";
    const spellings = [
      alias,
      value + "=",
      value.slice(0, -1),
      value.slice(0, 5) + " \t\r\n" + value.slice(5),
      value.slice(0, 5) + "!" + value.slice(5),
    ];
    const base64url = value.replaceAll("+", "-").replaceAll("/", "_");
    if (base64url !== value) spellings.push(base64url);
    for (const spelling of spellings) {
      expect(spelling).not.toBe(value);
      expect(Buffer.from(spelling, "base64")).toEqual(Buffer.from(value, "base64"));
      expect(verifyEnvelope(
        vector.envelope as unknown as AcsRequestEnvelope | AcsResponseEnvelope,
        key,
        { algorithm: "HMAC-SHA256", key_id: "lab", value: spelling },
      )).toBe(false);
    }
  });
});
