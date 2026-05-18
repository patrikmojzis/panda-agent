import type {PostgresGatewayStore} from "../../domain/gateway/postgres.js";
import {readTcpPort} from "../../lib/numbers.js";
import {trimToNull} from "../../lib/strings.js";
import type {GatewayWorker} from "./worker.js";

export const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export const DEFAULT_GATEWAY_PORT = 8094;
export const DEFAULT_GATEWAY_ACCESS_TOKEN_TTL_MS = 15 * 60_000;
export const DEFAULT_GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE = 20;
export const DEFAULT_GATEWAY_MAX_TEXT_BYTES = 64 * 1024;
export const DEFAULT_GATEWAY_RATE_LIMIT_PER_MINUTE = 120;
export const DEFAULT_GATEWAY_TEXT_BYTES_PER_HOUR = 5 * 1024 * 1024;

export interface GatewayServerOptions {
  env?: NodeJS.ProcessEnv;
  host?: string;
  maxActiveTokensPerSource?: number;
  maxTextBytes?: number;
  port?: number;
  rateLimitPerMinute?: number;
  store: PostgresGatewayStore;
  textBytesPerHour?: number;
  tokenTtlMs?: number;
  worker?: GatewayWorker;
}

export type GatewayHttpConfig = Omit<GatewayServerOptions, "store" | "worker">;

function readPositiveInteger(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected positive integer, got ${value}.`);
  }
  return parsed;
}

function parsePort(value: string | null, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = readTcpPort(value);
  if (parsed === undefined) {
    throw new Error(`Invalid gateway port: ${value}.`);
  }
  return parsed;
}

/**
 * Resolves gateway HTTP server knobs from env without mixing env parsing into
 * the public request dispatcher.
 */
export function resolveGatewayHttpConfig(env: NodeJS.ProcessEnv = process.env): GatewayHttpConfig {
  return {
    env,
    host: trimToNull(env.GATEWAY_HOST) ?? DEFAULT_GATEWAY_HOST,
    port: parsePort(trimToNull(env.GATEWAY_PORT), DEFAULT_GATEWAY_PORT),
    tokenTtlMs: readPositiveInteger(trimToNull(env.GATEWAY_ACCESS_TOKEN_TTL_MS), DEFAULT_GATEWAY_ACCESS_TOKEN_TTL_MS),
    maxActiveTokensPerSource: readPositiveInteger(
      trimToNull(env.GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE),
      DEFAULT_GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE,
    ),
    maxTextBytes: readPositiveInteger(trimToNull(env.GATEWAY_MAX_TEXT_BYTES), DEFAULT_GATEWAY_MAX_TEXT_BYTES),
    rateLimitPerMinute: readPositiveInteger(
      trimToNull(env.GATEWAY_RATE_LIMIT_PER_MINUTE),
      DEFAULT_GATEWAY_RATE_LIMIT_PER_MINUTE,
    ),
    textBytesPerHour: readPositiveInteger(
      trimToNull(env.GATEWAY_TEXT_BYTES_PER_HOUR),
      DEFAULT_GATEWAY_TEXT_BYTES_PER_HOUR,
    ),
  };
}

export function resolveGatewayServerOptions(
  store: PostgresGatewayStore,
  worker: GatewayWorker | undefined,
  env: NodeJS.ProcessEnv = process.env,
): GatewayServerOptions {
  return {
    ...resolveGatewayHttpConfig(env),
    store,
    ...(worker ? {worker} : {}),
  };
}
