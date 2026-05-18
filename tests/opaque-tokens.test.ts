import {describe, expect, it} from "vitest";

import {
  generateOpaqueToken,
  hashOpaqueToken,
  opaqueTokenMatches,
} from "../src/lib/opaque-tokens.js";

describe("opaque token helpers", () => {
  it("generates prefixed URL-safe tokens and matches only stored hashes", () => {
    const token = generateOpaqueToken("pat");
    const hash = hashOpaqueToken(token);

    expect(token).toMatch(/^pat_[A-Za-z0-9_-]+$/);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(opaqueTokenMatches(token, hash)).toBe(true);
    expect(opaqueTokenMatches(`${token}x`, hash)).toBe(false);
    expect(opaqueTokenMatches(token, "not-a-sha256-hash")).toBe(false);
  });

  it("preserves subsystem-specific entropy sizes", () => {
    expect(generateOpaqueToken("pdt", 24)).toMatch(/^pdt_[A-Za-z0-9_-]{32}$/);
    expect(generateOpaqueToken("pal")).toMatch(/^pal_[A-Za-z0-9_-]{43}$/);
  });
});
