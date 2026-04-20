import {resolveMediaDir} from "../../../app/runtime/data-dir.js";
import {trimToNull} from "../../../lib/strings.js";

export { resolveDataDir } from "../../../app/runtime/data-dir.js";

export function requireTelegramBotToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = trimToNull(env.TELEGRAM_BOT_TOKEN);
  if (token) {
    return token;
  }

  throw new Error("Telegram requires TELEGRAM_BOT_TOKEN in .env.");
}

export const resolveTelegramMediaDir = resolveMediaDir;

export const TELEGRAM_SOURCE = "telegram";
export const TELEGRAM_UPDATES_CURSOR_KEY = "updates";
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;
