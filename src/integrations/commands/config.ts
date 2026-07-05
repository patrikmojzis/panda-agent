import {readTcpPort} from "../../lib/numbers.js";
import {trimToNull} from "../../lib/strings.js";

export const DEFAULT_COMMAND_SERVER_HOST = "127.0.0.1";
export const DEFAULT_COMMAND_SERVER_PORT = 8096;

export interface CommandServerBinding {
  host: string;
  port: number;
  socketPath?: string;
  publicUrl?: string;
}

function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function readCommandServerPort(value: string | undefined): number {
  const raw = trimToNull(value);
  if (!raw) return DEFAULT_COMMAND_SERVER_PORT;
  const parsed = readTcpPort(raw, {allowZero: true});
  if (parsed === undefined) {
    throw new Error("PANDA_COMMAND_SERVER_PORT must be an integer between 0 and 65535.");
  }
  return parsed;
}

function formatHostForUrl(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function buildCommandServerBaseUrl(binding: Pick<CommandServerBinding, "host" | "port" | "publicUrl">): string {
  const publicUrl = trimToNull(binding.publicUrl);
  if (publicUrl) {
    return publicUrl.replace(/\/+$/, "");
  }

  return `http://${formatHostForUrl(binding.host)}:${binding.port}`;
}

export function resolveOptionalCommandServerBinding(env: NodeJS.ProcessEnv = process.env): CommandServerBinding | null {
  const socketPath = trimToNull(env.PANDA_COMMAND_SERVER_SOCKET_PATH);
  const enabled = envFlagEnabled(env.PANDA_COMMAND_SERVER_ENABLED) || Boolean(socketPath);
  if (!enabled) {
    return null;
  }

  return {
    host: trimToNull(env.PANDA_COMMAND_SERVER_HOST) ?? DEFAULT_COMMAND_SERVER_HOST,
    port: readCommandServerPort(env.PANDA_COMMAND_SERVER_PORT),
    ...(socketPath ? {socketPath} : {}),
    ...(trimToNull(env.PANDA_COMMAND_SERVER_URL) ? {publicUrl: trimToNull(env.PANDA_COMMAND_SERVER_URL)!} : {}),
  };
}
