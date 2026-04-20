import {InvalidArgumentError} from "commander";

/**
 * Parses a Commander option value as a positive integer.
 */
export function parsePositiveIntegerOption(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError("Expected a positive integer.");
  }

  return parsed;
}

/**
 * Trims a required Commander string option and rejects blank values with a
 * caller-provided label.
 */
export function parseRequiredOptionValue(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new InvalidArgumentError(`${label} must not be empty.`);
  }

  return trimmed;
}

/**
 * Parses a non-empty session id option or argument.
 */
export function parseSessionIdOption(value: string): string {
  return parseRequiredOptionValue(value, "Session id");
}
