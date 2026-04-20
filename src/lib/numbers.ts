/**
 * Clamps `value` into the inclusive [`min`, `max`] range.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Returns a finite positive integer when `value` can be interpreted as one.
 */
export function readPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

/**
 * Returns a finite non-negative number when `value` already has that shape.
 */
export function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
