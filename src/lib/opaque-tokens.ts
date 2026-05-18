import {createHash, randomBytes, timingSafeEqual} from "node:crypto";

/**
 * Generates a URL-safe opaque token with a short domain prefix.
 */
export function generateOpaqueToken(prefix: string, byteLength = 32): string {
  return `${prefix}_${randomBytes(byteLength).toString("base64url")}`;
}

/**
 * Hashes opaque tokens before persistence so raw bearer values stay write-only.
 */
export function hashOpaqueToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compares a presented opaque token with its stored hash without leaking prefix
 * match progress through ordinary string comparison.
 */
export function opaqueTokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOpaqueToken(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
