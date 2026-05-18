/**
 * Ensures that `value` is a boolean while letting callers keep domain-specific
 * row-validation error text.
 */
export function requireBoolean(value: unknown, errorMessage: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(errorMessage);
  }

  return value;
}
