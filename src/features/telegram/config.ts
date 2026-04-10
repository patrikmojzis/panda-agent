import {resolvePandaMediaDir} from "../panda/data-dir.js";

export { resolvePandaDataDir } from "../panda/data-dir.js";

function trimNonEmptyString(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed || null;
}

export function requireTelegramBotToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = trimNonEmptyString(env.TELEGRAM_BOT_TOKEN);
  if (token) {
    return token;
  }

  throw new Error("Telegram requires TELEGRAM_BOT_TOKEN in .env.");
}

export function resolveTelegramMediaDir(env: NodeJS.ProcessEnv = process.env): string {
  return resolvePandaMediaDir(env);
}

export const TELEGRAM_SOURCE = "telegram";
export const TELEGRAM_UPDATES_CURSOR_KEY = "updates";
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;
