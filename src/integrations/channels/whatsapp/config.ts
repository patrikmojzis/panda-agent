import {resolveMediaDir} from "../../../app/runtime/data-dir.js";
import {trimToNull} from "../../../lib/strings.js";

export { resolveDataDir } from "../../../app/runtime/data-dir.js";

export const resolveWhatsAppDataDir = resolveMediaDir;

export function resolveWhatsAppConnectorKey(env: NodeJS.ProcessEnv = process.env): string {
  return trimToNull(env.WHATSAPP_CONNECTOR_KEY) ?? "main";
}

export const WHATSAPP_SOURCE = "whatsapp";
