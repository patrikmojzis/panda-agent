import type {TelegramStickerStore} from "./store.js";
import {
  buildTelegramStickerSetItemRef,
  parseTelegramStickerSetItemRef,
  type ImportTelegramStickersResult,
  type ListTelegramStickersFilter,
  type TelegramStickerItem,
  type TelegramStickerRecord,
  type TelegramStickerSetSnapshot,
} from "./types.js";

export interface TelegramStickerSetReader {
  readSet(connectorKey: string, setName: string): Promise<TelegramStickerSetSnapshot>;
}

export class TelegramStickerLibrary {
  constructor(
    private readonly store: TelegramStickerStore,
    private readonly sets: TelegramStickerSetReader,
  ) {}

  async saveSticker(input: {
    agentKey: string;
    connectorKey: string;
    sticker: TelegramStickerItem;
    tags?: readonly string[];
    description?: string;
  }): Promise<TelegramStickerRecord> {
    const result = await this.store.importStickers({
      agentKey: input.agentKey,
      connectorKey: input.connectorKey,
      stickers: [input.sticker],
      tags: input.tags,
      description: input.description,
    });
    return result.stickers[0]!;
  }

  async readSet(connectorKey: string, setName: string): Promise<TelegramStickerSetSnapshot> {
    return await this.sets.readSet(connectorKey, setName);
  }

  async saveSet(input: {
    agentKey: string;
    connectorKey: string;
    setName: string;
    all?: boolean;
    stickerRefs?: readonly string[];
    tags?: readonly string[];
    description?: string;
  }): Promise<ImportTelegramStickersResult & {set: TelegramStickerSetSnapshot}> {
    const set = await this.readSet(input.connectorKey, input.setName);
    const requested = new Set((input.stickerRefs ?? []).map(parseTelegramStickerSetItemRef));
    if (input.all !== true && requested.size === 0) {
      throw new Error("Telegram sticker set save requires all=true or at least one fileUniqueId.");
    }
    const stickers = input.all === true
      ? set.stickers
      : set.stickers.filter((sticker) => requested.has(
        buildTelegramStickerSetItemRef(set.name, sticker.fileUniqueId),
      ));
    if (stickers.length !== (input.all === true ? set.stickers.length : requested.size)) {
      throw new Error("Telegram sticker set no longer contains every requested sticker.");
    }
    return {
      set,
      ...await this.store.importStickers({
        agentKey: input.agentKey,
        connectorKey: input.connectorKey,
        stickers,
        tags: input.tags,
        description: input.description,
      }),
    };
  }

  async getSticker(agentKey: string, id: string): Promise<TelegramStickerRecord | null> {
    return await this.store.getSticker(agentKey, id);
  }

  async listStickers(filter: ListTelegramStickersFilter): Promise<readonly TelegramStickerRecord[]> {
    return await this.store.listStickers(filter);
  }
}
