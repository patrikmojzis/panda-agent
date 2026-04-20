import {requireNonEmptyString} from "../../lib/strings.js";

/**
 * Ensures that a required A2A identifier is present and trimmed.
 */
export function requireA2AString(field: string, value: string | null | undefined): string {
  return requireNonEmptyString(value, `A2A ${field} must not be empty.`);
}
