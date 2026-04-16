import {resolveMediaDir} from "../../../app/runtime/data-dir.js";

export { resolveDataDir } from "../../../app/runtime/data-dir.js";

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function resolveWhatsAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolveMediaDir(env);
}

export function resolveWhatsAppConnectorKey(env: NodeJS.ProcessEnv = process.env): string {
  return trimNonEmptyString(env.WHATSAPP_CONNECTOR_KEY) ?? "main";
}

export const WHATSAPP_SOURCE = "whatsapp";
