/**
 * Converts a millisecond timestamp into a `Date`, while preserving `undefined`
 * as `null` for SQL parameter helpers.
 */
export function toDateOrNull(value: number | undefined): Date | null {
  return value === undefined ? null : new Date(value);
}
