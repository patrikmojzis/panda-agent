/**
 * Returns true when `value` is a plain record-like object.
 *
 * Arrays and `null` are excluded so callers can safely read string keys from
 * the result without sprinkling the same shape guard everywhere.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
