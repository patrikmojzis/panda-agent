import {createHash, randomBytes, timingSafeEqual} from "node:crypto";

export function generateTelepathyToken(): string {
  return `pdt_${randomBytes(24).toString("base64url")}`;
}

export function hashTelepathyToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function telepathyTokenMatches(token: string, expectedHash: string): boolean {
  const actualHash = hashTelepathyToken(token);
  const actual = Buffer.from(actualHash, "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
