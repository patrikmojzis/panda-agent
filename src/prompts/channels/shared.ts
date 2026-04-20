/**
 * Renders optional string fields for the channel prompt wrappers.
 */
export function formatMaybeValue(value: string | undefined): string {
  return value?.trim() || "null";
}
