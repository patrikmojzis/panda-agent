import {Bot, type Api} from "grammy";

import type {TelegramStickerSetReader} from "../../../domain/agents/telegram-stickers/service.js";
import {
  MAX_TELEGRAM_STICKER_IMPORT,
  type TelegramStickerSetSnapshot,
} from "../../../domain/agents/telegram-stickers/types.js";
import type {ConnectorAccountRecord} from "../../../domain/connectors/types.js";
import type {CredentialCrypto} from "../../../domain/credentials/crypto.js";
import {TELEGRAM_BOT_TOKEN_SECRET_KEY, TELEGRAM_SOURCE} from "./config.js";
import {inferTelegramStickerFormat} from "./sticker-metadata.js";
import {withTelegramSecretErrorSafety} from "./account.js";

const TELEGRAM_STICKER_SET_TIMEOUT_MS = 10_000;

export interface TelegramStickerSetAccountStore {
  getAccountByConnectorKey(source: string, connectorKey: string): Promise<ConnectorAccountRecord | null>;
  getSecret(accountId: string, secretKey: string, crypto: CredentialCrypto | null | undefined): Promise<string | null>;
}

export interface TelegramStickerSetReaderOptions {
  accounts: TelegramStickerSetAccountStore;
  crypto: CredentialCrypto | null | undefined;
  createApi?: (token: string) => Pick<Api, "getStickerSet">;
  timeoutMs?: number;
}

function createDefaultApi(token: string): Pick<Api, "getStickerSet"> {
  return new Bot(token).api;
}

export function createTelegramStickerSetReader(options: TelegramStickerSetReaderOptions): TelegramStickerSetReader {
  return {
    async readSet(connectorKey: string, rawSetName: string): Promise<TelegramStickerSetSnapshot> {
      const setName = rawSetName.trim();
      if (!setName) {
        throw new Error("Telegram sticker set name must not be empty.");
      }
      const account = await options.accounts.getAccountByConnectorKey(TELEGRAM_SOURCE, connectorKey);
      if (!account || account.status !== "enabled") {
        throw new Error(`No enabled Telegram connector ${connectorKey} is available.`);
      }
      const token = await options.accounts.getSecret(account.id, TELEGRAM_BOT_TOKEN_SECRET_KEY, options.crypto);
      if (!token) {
        throw new Error(`Telegram connector ${connectorKey} has no stored bot token.`);
      }
      const controller = new AbortController();
      const timeoutMs = options.timeoutMs ?? TELEGRAM_STICKER_SET_TIMEOUT_MS;
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      timeout.unref?.();
      try {
        const api = (options.createApi ?? createDefaultApi)(token);
        const set = await withTelegramSecretErrorSafety(token, () =>
          api.getStickerSet(setName, controller.signal as Parameters<Api["getStickerSet"]>[1]),
        );
        if (set.stickers.length > MAX_TELEGRAM_STICKER_IMPORT) {
          throw new Error(
            `Telegram sticker set ${set.name} contains ${String(set.stickers.length)} stickers; Panda imports at most ${MAX_TELEGRAM_STICKER_IMPORT}.`,
          );
        }
        return {
          name: set.name,
          title: set.title,
          stickerType: set.sticker_type,
          stickers: set.stickers.map((sticker) => ({
            fileId: sticker.file_id,
            fileUniqueId: sticker.file_unique_id,
            setName: sticker.set_name ?? set.name,
            setTitle: set.title,
            emoji: sticker.emoji,
            stickerType: sticker.type,
            format: inferTelegramStickerFormat(sticker),
            width: sticker.width,
            height: sticker.height,
            sizeBytes: sticker.file_size,
          })),
        };
      } catch (error) {
        if (controller.signal.aborted) {
          throw new Error(`Telegram sticker set lookup timed out after ${String(timeoutMs)}ms.`);
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
