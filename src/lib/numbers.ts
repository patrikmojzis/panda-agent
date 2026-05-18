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

/**
 * Returns a non-negative integer or throws using the caller's field label.
 */
export function requireNonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return value;
}

/**
 * Parses a TCP port number. Server binding config may opt into port 0 when it
 * wants the OS to choose a free ephemeral port.
 */
export function readTcpPort(
  value: unknown,
  options: {
    allowZero?: boolean;
  } = {},
): number | undefined {
  const parsed = typeof value === "string" && value.trim()
    ? Number(value)
    : typeof value === "number"
      ? value
      : undefined;
  if (parsed === undefined || !Number.isInteger(parsed)) {
    return undefined;
  }

  const minPort = options.allowZero ? 0 : 1;
  return parsed >= minPort && parsed <= 65_535 ? parsed : undefined;
}
