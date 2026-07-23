import type {
  ImportTelegramStickersInput,
  ImportTelegramStickersResult,
  ListTelegramStickersFilter,
  TelegramStickerRecord,
} from "./types.js";

export interface TelegramStickerStore {
  importStickers(input: ImportTelegramStickersInput): Promise<ImportTelegramStickersResult>;
  getSticker(agentKey: string, id: string): Promise<TelegramStickerRecord | null>;
  listStickers(filter: ListTelegramStickersFilter): Promise<readonly TelegramStickerRecord[]>;
}
