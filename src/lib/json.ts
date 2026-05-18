export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  return isJsonObject(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  return Object.values(value).every(isJsonValue);
}

/**
 * Returns a JSON value or throws using the caller's field label.
 */
export function requireJsonValue(value: unknown, label: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`${label} must be JSON-serializable.`);
  }

  return value;
}

/**
 * Returns a JSON value when present. Null and undefined both mean absent.
 */
export function readOptionalJsonValue(value: unknown, label: string): JsonValue | undefined {
  return value === null || value === undefined ? undefined : requireJsonValue(value, label);
}

/**
 * Serializes a present JSON value, returning null for absent database fields.
 */
export function stringifyOptionalJsonValue(
  value: JsonValue | undefined,
  label: string,
): string | null {
  return value === undefined ? null : JSON.stringify(requireJsonValue(value, label));
}

/**
 * Converts runtime/source values into JSON values while preserving useful
 * scalars such as BigInt, Date, Buffer, and Mongo-style ObjectId values.
 */
export function normalizeToJsonValue(value: unknown): JsonValue {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }

  if (isJsonValue(value)) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeToJsonValue(entry));
  }

  if (typeof value === "object" && value !== null) {
    const asObject = value as Record<string, unknown>;
    const toHexString = asObject.toHexString;
    if (typeof toHexString === "function") {
      return String(toHexString.call(value));
    }

    const normalized: JsonObject = {};
    for (const [key, entry] of Object.entries(asObject)) {
      if (entry === undefined) {
        continue;
      }
      normalized[key] = normalizeToJsonValue(entry);
    }
    return normalized;
  }

  return String(value);
}

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
