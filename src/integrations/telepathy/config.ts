import {readTcpPort} from "../../lib/numbers.js";
import {trimToNull} from "../../lib/strings.js";

export const TELEPATHY_SOURCE = "telepathy";
const DEFAULT_TELEPATHY_HOST = "127.0.0.1";
const DEFAULT_TELEPATHY_PORT = 8787;
const DEFAULT_TELEPATHY_PATH = "/telepathy";

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return `/${trimmed}`;
  }

  return trimmed;
}

function readPort(value: string | null): number {
  if (!value) {
    return DEFAULT_TELEPATHY_PORT;
  }

  const parsed = readTcpPort(value);
  if (parsed === undefined) {
    throw new Error(`Invalid telepathy port: ${value}`);
  }

  return parsed;
}

export function resolveTelepathyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = trimToNull(env.TELEPATHY_ENABLED);
  if (raw) {
    return /^(1|true|yes|on)$/i.test(raw);
  }

  return trimToNull(env.TELEPATHY_PORT) !== null;
}

export function resolveTelepathyHost(env: NodeJS.ProcessEnv = process.env): string {
  return trimToNull(env.TELEPATHY_HOST) ?? DEFAULT_TELEPATHY_HOST;
}

export function resolveTelepathyPort(env: NodeJS.ProcessEnv = process.env): number {
  return readPort(trimToNull(env.TELEPATHY_PORT));
}

export function resolveTelepathyPath(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeTelepathyPath(trimToNull(env.TELEPATHY_PATH) ?? DEFAULT_TELEPATHY_PATH);
}

export function normalizeTelepathyPath(value: string): string {
  return normalizePath(value);
}
