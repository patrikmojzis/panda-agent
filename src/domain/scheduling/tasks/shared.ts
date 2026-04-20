import {requireNonEmptyString} from "../../../lib/strings.js";

/**
 * Ensures that a scheduled-task string field is present and trimmed.
 */
export function requireScheduledTaskString(field: string, value: string): string {
  return requireNonEmptyString(value, `Scheduled task ${field} must not be empty.`);
}
