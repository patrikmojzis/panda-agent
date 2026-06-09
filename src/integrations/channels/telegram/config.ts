import {trimToNull} from "../../../lib/strings.js";

export function requireTelegramBotToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = trimToNull(env.TELEGRAM_BOT_TOKEN);
  if (token) {
    return token;
  }

  throw new Error("Telegram bot token is required.");
}

export const TELEGRAM_SOURCE = "telegram";
export const TELEGRAM_BOT_TOKEN_SECRET_KEY = "bot_token";
export const TELEGRAM_UPDATES_CURSOR_KEY = "updates";
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;
