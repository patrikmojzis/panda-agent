import os from "node:os";
import path from "node:path";

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

export function resolveTelegramMediaDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolvePandaDataDir(env), "media");
}

export const TELEGRAM_SOURCE = "telegram";
export const TELEGRAM_UPDATES_CURSOR_KEY = "updates";
export const TELEGRAM_POLL_TIMEOUT_SECONDS = 30;
