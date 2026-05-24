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
export const DEFAULT_GATEWAY_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_GATEWAY_MAX_ATTACHMENTS_PER_EVENT = 5;
export const DEFAULT_GATEWAY_MAX_EVENT_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const DEFAULT_GATEWAY_ATTACHMENT_BYTES_PER_HOUR = 100 * 1024 * 1024;
export const DEFAULT_GATEWAY_MAX_PENDING_ATTACHMENTS_PER_SOURCE = 100;
export const DEFAULT_GATEWAY_ATTACHMENT_UPLOAD_TTL_MS = 60 * 60_000;
export const DEFAULT_GATEWAY_DEVICE_COMMAND_MAX_WAIT_MS = 30_000;
export const DEFAULT_GATEWAY_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_GATEWAY_ATTACHMENT_QUARANTINE_TTL_MS = 24 * 60 * 60_000;
export const DEFAULT_GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES = [
  "text/plain",
  "application/json",
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "audio/mpeg",
  "audio/mp4",
  "audio/m4a",
  "audio/ogg",
  "audio/opus",
] as const;

export interface GatewayServerOptions {
  attachmentAllowedMimeTypes?: readonly string[];
  attachmentBytesPerHour?: number;
  attachmentQuarantineTtlMs?: number;
  attachmentRetentionMs?: number;
  attachmentUploadTtlMs?: number;
  deviceCommandMaxWaitMs?: number;
  env?: NodeJS.ProcessEnv;
  host?: string;
  maxActiveTokensPerSource?: number;
  maxAttachmentBytes?: number;
  maxAttachmentsPerEvent?: number;
  maxEventAttachmentBytes?: number;
  maxPendingAttachmentsPerSource?: number;
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

function parseMimeAllowlist(value: string | null): readonly string[] {
  if (!value) {
    return DEFAULT_GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES;
  }
  const parsed = value
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (parsed.length === 0) {
    throw new Error("GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES must include at least one MIME type.");
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
    maxAttachmentBytes: readPositiveInteger(
      trimToNull(env.GATEWAY_MAX_ATTACHMENT_BYTES),
      DEFAULT_GATEWAY_MAX_ATTACHMENT_BYTES,
    ),
    maxAttachmentsPerEvent: readPositiveInteger(
      trimToNull(env.GATEWAY_MAX_ATTACHMENTS_PER_EVENT),
      DEFAULT_GATEWAY_MAX_ATTACHMENTS_PER_EVENT,
    ),
    maxEventAttachmentBytes: readPositiveInteger(
      trimToNull(env.GATEWAY_MAX_EVENT_ATTACHMENT_BYTES),
      DEFAULT_GATEWAY_MAX_EVENT_ATTACHMENT_BYTES,
    ),
    attachmentBytesPerHour: readPositiveInteger(
      trimToNull(env.GATEWAY_ATTACHMENT_BYTES_PER_HOUR),
      DEFAULT_GATEWAY_ATTACHMENT_BYTES_PER_HOUR,
    ),
    maxPendingAttachmentsPerSource: readPositiveInteger(
      trimToNull(env.GATEWAY_MAX_PENDING_ATTACHMENTS_PER_SOURCE),
      DEFAULT_GATEWAY_MAX_PENDING_ATTACHMENTS_PER_SOURCE,
    ),
    attachmentUploadTtlMs: readPositiveInteger(
      trimToNull(env.GATEWAY_ATTACHMENT_UPLOAD_TTL_MS),
      DEFAULT_GATEWAY_ATTACHMENT_UPLOAD_TTL_MS,
    ),
    deviceCommandMaxWaitMs: readPositiveInteger(
      trimToNull(env.GATEWAY_DEVICE_COMMAND_MAX_WAIT_MS),
      DEFAULT_GATEWAY_DEVICE_COMMAND_MAX_WAIT_MS,
    ),
    attachmentRetentionMs: readPositiveInteger(
      trimToNull(env.GATEWAY_ATTACHMENT_RETENTION_MS),
      DEFAULT_GATEWAY_ATTACHMENT_RETENTION_MS,
    ),
    attachmentQuarantineTtlMs: readPositiveInteger(
      trimToNull(env.GATEWAY_ATTACHMENT_QUARANTINE_TTL_MS),
      DEFAULT_GATEWAY_ATTACHMENT_QUARANTINE_TTL_MS,
    ),
    attachmentAllowedMimeTypes: parseMimeAllowlist(trimToNull(env.GATEWAY_ATTACHMENT_ALLOWED_MIME_TYPES)),
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
