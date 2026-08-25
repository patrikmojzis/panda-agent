import {describe, expect, it} from "vitest";

import {SecretCrypto} from "../src/domain/secrets/crypto.js";

describe("SecretCrypto", () => {
  const crypto = new SecretCrypto("test-master-key");
  const context = {purpose: "agent-credential", identity: ["panda", "OPENAI_API_KEY"]};

  it("round-trips a v2 envelope only with its exact authenticated context", () => {
    const encrypted = crypto.seal("secret-value", context);

    expect(encrypted.envelopeVersion).toBe(2);
    expect(crypto.open(encrypted, context)).toBe("secret-value");
    expect(() => crypto.open(encrypted, {...context, identity: ["luna", "OPENAI_API_KEY"]})).toThrow();
    expect(() => crypto.open(encrypted, {...context, identity: ["panda", "GITHUB_TOKEN"]})).toThrow();
    expect(() => crypto.open(encrypted, {...context, purpose: "connector-account-secret"})).toThrow();
  });

  it("rejects modified envelope bytes and unsupported versions", () => {
    const encrypted = crypto.seal("secret-value", context);
    const ciphertext = Buffer.from(encrypted.ciphertext);
    ciphertext[0] = ciphertext[0]! ^ 1;

    expect(() => crypto.open({...encrypted, ciphertext}, context)).toThrow();
    expect(() => crypto.open({...encrypted, envelopeVersion: 1}, context)).toThrow(
      "Unsupported secret envelope version 1.",
    );
  });

  it("rejects empty master keys and malformed contexts", () => {
    expect(() => new SecretCrypto("  ")).toThrow("CREDENTIALS_MASTER_KEY must not be empty.");
    expect(() => crypto.seal("value", {purpose: " ", identity: ["panda"]})).toThrow();
    expect(() => crypto.seal("value", {purpose: "test", identity: [""]})).toThrow();
  });
});
