import type {WAVersion} from "baileys";

import {resolveMediaDir} from "../../../app/runtime/data-dir.js";
import {trimToNull} from "../../../lib/strings.js";

export { resolveDataDir } from "../../../app/runtime/data-dir.js";

export const resolveWhatsAppDataDir = resolveMediaDir;

export function resolveWhatsAppConnectorKey(env: NodeJS.ProcessEnv = process.env): string {
  return trimToNull(env.WHATSAPP_CONNECTOR_KEY) ?? "main";
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
