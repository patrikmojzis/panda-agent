import type {JsonObject, JsonValue} from "../../lib/json.js";

/**
 * Replaces every exact secret occurrence in `value` with a redaction marker.
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

    redacted = redacted.split(secret).join("[redacted]");
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
