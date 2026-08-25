import type {WAVersion} from "baileys";

import {trimToNull} from "../../../lib/strings.js";

export const DEFAULT_WHATSAPP_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const DEFAULT_WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
export const DEFAULT_WHATSAPP_MEDIA_CONCURRENCY = 2;
export const DEFAULT_WHATSAPP_MEDIA_QUEUE_MAX = 16;

export interface WhatsAppIngressLimits {
  maxMediaBytes: number;
  mediaDownloadTimeoutMs: number;
  mediaConcurrency: number;
  mediaQueueMax: number;
}

function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const rawValue = trimToNull(env[name]);
  if (!rawValue) return fallback;
  if (!/^[1-9][0-9]*$/.test(rawValue)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(rawValue);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return parsed;
}

export function resolveWhatsAppIngressLimits(
  env: NodeJS.ProcessEnv = process.env,
): WhatsAppIngressLimits {
  return {
    maxMediaBytes: readPositiveIntegerEnv(
      env,
      "PANDA_WHATSAPP_MAX_MEDIA_BYTES",
      DEFAULT_WHATSAPP_MAX_MEDIA_BYTES,
    ),
    mediaDownloadTimeoutMs: readPositiveIntegerEnv(
      env,
      "PANDA_WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS",
      DEFAULT_WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS,
    ),
    mediaConcurrency: readPositiveIntegerEnv(
      env,
      "PANDA_WHATSAPP_MEDIA_CONCURRENCY",
      DEFAULT_WHATSAPP_MEDIA_CONCURRENCY,
    ),
    mediaQueueMax: readPositiveIntegerEnv(
      env,
      "PANDA_WHATSAPP_MEDIA_QUEUE_MAX",
      DEFAULT_WHATSAPP_MEDIA_QUEUE_MAX,
    ),
  };
}

/**
 * Lets operators pin Baileys' WhatsApp Web version when WhatsApp rejects the
 * bundled default during login. Format: 2.3000.1035194821.
 */
export function resolveWhatsAppSocketVersion(env: NodeJS.ProcessEnv = process.env): WAVersion | undefined {
  const rawValue = trimToNull(env.PANDA_WHATSAPP_VERSION);
  if (!rawValue) {
    return undefined;
  }

  const parts = rawValue.split(".");
  if (parts.length !== 3) {
    throw new Error("PANDA_WHATSAPP_VERSION must use <major>.<minor>.<revision> format.");
  }

  const version = parts.map((part) => Number(part));
  if (version.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error("PANDA_WHATSAPP_VERSION must contain three non-negative integer parts.");
  }

  return version as WAVersion;
}

export const WHATSAPP_SOURCE = "whatsapp";
