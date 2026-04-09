import os from "node:os";
import path from "node:path";

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function resolvePandaDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = trimNonEmptyString(env.PANDA_DATA_DIR);
  if (!configured) {
    return path.join(os.homedir(), ".panda");
  }

  if (configured === "~") {
    return os.homedir();
  }

  if (configured.startsWith("~/")) {
    return path.join(os.homedir(), configured.slice(2));
  }

  return path.resolve(configured);
}

export function resolveWhatsAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePandaDataDir(env), "media");
}

export function resolveWhatsAppConnectorKey(env: NodeJS.ProcessEnv = process.env): string {
  return trimNonEmptyString(env.WHATSAPP_CONNECTOR_KEY) ?? "main";
}

export const WHATSAPP_SOURCE = "whatsapp";
