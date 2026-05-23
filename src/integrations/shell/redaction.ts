import type {JsonObject, JsonValue} from "../../lib/json.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordLikeSecret(value: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(value);
}

/**
 * Replaces secret occurrences in `value` with a redaction marker.
 *
 * Secrets are expected to be pre-sorted longest-first by the caller when
 * overlap matters.
 */
export function redactSecretsInString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }

    const escaped = escapeRegExp(secret);
    if (isWordLikeSecret(secret)) {
      redacted = redacted.replace(
        new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "g"),
        "$1[redacted]",
      );
      continue;
    }

    redacted = redacted.replace(new RegExp(escaped, "g"), "[redacted]");
  }

  return redacted;
}

/**
 * Walks a JSON value and redacts any embedded secret strings.
 */
export function redactSecretsInJson(value: JsonValue, secrets: readonly string[]): JsonValue {
  if (typeof value === "string") {
    return redactSecretsInString(value, secrets);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretsInJson(entry, secrets));
  }

  if (value && typeof value === "object") {
    return redactSecretsInJsonObject(value, secrets);
  }

  return value;
}

export function redactSecretsInJsonObject(value: JsonObject, secrets: readonly string[]): JsonObject {
  const redacted: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactSecretsInJson(entry, secrets);
  }
  return redacted;
}
