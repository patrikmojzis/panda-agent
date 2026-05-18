import {optionalNonEmptyString, requireNonEmptyString} from "../../../lib/strings.js";

/**
 * Ensures that a scheduled-task string field is present and trimmed.
 */
export function requireScheduledTaskString(field: string, value: unknown): string {
  return requireNonEmptyString(value, `Scheduled task ${field} must not be empty.`);
}

/**
 * Reads an optional scheduled-task string field while rejecting empty present values.
 */
export function optionalScheduledTaskString(field: string, value: unknown): string | undefined {
  return optionalNonEmptyString(value, `Scheduled task ${field} must not be empty.`);
}
