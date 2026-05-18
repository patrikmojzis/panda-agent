/**
 * Convert trusted Postgres timestamp row values into epoch milliseconds.
 * TIMESTAMPTZ columns should arrive as Date objects; tests may use numeric
 * milliseconds. String parsing belongs at explicit external seams.
 */
export function toMillis(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (value instanceof Date) {
    return value.getTime();
  }

  return Number.NaN;
}

/**
 * Requires a trusted Postgres timestamp row value and preserves caller-owned
 * row-validation error text.
 */
export function requireTimestampMillis(value: unknown, errorMessage: string): number {
  const millis = toMillis(value);
  if (!Number.isFinite(millis)) {
    throw new Error(errorMessage);
  }

  return millis;
}

/**
 * Reads a nullable Postgres timestamp row value as an optional epoch millis.
 */
export function optionalTimestampMillis(value: unknown, errorMessage: string): number | undefined {
  return value === null || value === undefined ? undefined : requireTimestampMillis(value, errorMessage);
}

/**
 * Reads a nullable Postgres timestamp row value as a nullable epoch millis.
 */
export function nullableTimestampMillis(value: unknown, errorMessage: string): number | null {
  return value === null || value === undefined ? null : requireTimestampMillis(value, errorMessage);
}

/**
 * Serializes JSONB parameters while preserving the repo's undefined-as-NULL convention.
 */
export function toJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
