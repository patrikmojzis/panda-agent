import type {JsonObject, JsonValue} from "../../lib/json.js";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isWordLikeSecret(value: string): boolean {
  return /^[A-Za-z0-9_]+$/.test(value);
}

const BASH_TRUNCATION_MARKER_PATTERN = "\n\n…\\d+ chars truncated…\n\n";
const MINIMUM_TRUNCATED_SECRET_FRAGMENT_LENGTH = 6;

function redactSecretFragmentsAtTruncationMarkers(value: string, secrets: readonly string[]): string {
  // Head/tail previews can cut through a secret before exact-value redaction runs.
  // Redact only 6+ char fragments touching the truncation marker to avoid broad over-redaction.
  if (!value.includes(" chars truncated")) {
    return value;
  }

  let redacted = value;
  for (const secret of secrets) {
    const minimumLength = MINIMUM_TRUNCATED_SECRET_FRAGMENT_LENGTH;
    if (secret.length <= minimumLength) {
      continue;
    }

    for (let length = secret.length - 1; length >= minimumLength; length -= 1) {
      const prefix = escapeRegExp(secret.slice(0, length));
      redacted = redacted.replace(
        new RegExp(`${prefix}(?=${BASH_TRUNCATION_MARKER_PATTERN})`, "g"),
        "[redacted]",
      );

      const suffix = escapeRegExp(secret.slice(secret.length - length));
      redacted = redacted.replace(
        new RegExp(`(${BASH_TRUNCATION_MARKER_PATTERN})${suffix}`, "g"),
        "$1[redacted]",
      );
    }
  }

  return redacted;
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

  return redactSecretFragmentsAtTruncationMarkers(redacted, secrets);
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
