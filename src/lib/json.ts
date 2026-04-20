import type {JsonValue} from "../kernel/agent/types.js";

/**
 * Serializes JSON values with stable object-key ordering so hashing and
 * equality checks do not depend on insertion order.
 */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  const entries = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key] as JsonValue)}`);
  return `{${entries.join(",")}}`;
}
