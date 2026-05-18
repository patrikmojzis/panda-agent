/**
 * Returns a trimmed filesystem path segment when it cannot escape its parent.
 */
export function readSafePathSegment(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\\/]/.test(trimmed) || trimmed.includes("..")) {
    return null;
  }

  return trimmed;
}

/**
 * Normalizes user/runtime labels into filesystem-safe path segment labels.
 */
export function normalizePathLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "unknown";
}
