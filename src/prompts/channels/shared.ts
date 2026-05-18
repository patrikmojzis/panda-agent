/**
 * Renders optional string fields for the channel prompt wrappers.
 */
export function formatMaybeValue(value: string | undefined): string {
  return value?.trim() || "null";
}

/**
 * Renders untrusted metadata as a single prompt-safe string value.
 */
export function formatUntrustedStringValue(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
