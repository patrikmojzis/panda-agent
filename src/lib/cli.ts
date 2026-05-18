import {InvalidArgumentError} from "commander";

import {readTcpPort} from "./numbers.js";

/**
 * Shared Commander help text for Panda Postgres connection options.
 */
export const DB_URL_OPTION_DESCRIPTION = "Postgres connection string for Panda persistence";

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
 * Parses a Commander option value as a TCP port number.
 */
export function parsePortOption(value: string): number {
  return parsePort(value, "Port");
}

/**
 * Builds a Commander option parser for a labeled TCP port number.
 */
export function parseLabeledPortOption(label: string): (value: string) => number {
  return (value) => parsePort(value, label);
}

function parsePort(value: string, label: string): number {
  const parsed = readTcpPort(value);
  if (parsed === undefined) {
    throw new InvalidArgumentError(`${label} must be an integer between 1 and 65535.`);
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
