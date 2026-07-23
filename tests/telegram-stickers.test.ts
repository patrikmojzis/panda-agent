import {describe, expect, it, vi} from "vitest";

import {TelegramStickerLibrary} from "../src/domain/agents/telegram-stickers/service.js";
import type {TelegramStickerStore} from "../src/domain/agents/telegram-stickers/store.js";
import {
  buildTelegramStickerLibraryRef,
  buildTelegramStickerSetItemRef,
  normalizeTelegramStickerImport,
  type ImportTelegramStickersInput,
  type ListTelegramStickersFilter,
  type TelegramStickerItem,
  type TelegramStickerRecord,
} from "../src/domain/agents/telegram-stickers/types.js";
import type {CommandRequest} from "../src/domain/commands/types.js";
import {
  createTelegramStickerSendCommand,
  TELEGRAM_STICKER_SEND_COMMAND_NAME,
} from "../src/integrations/channels/telegram/commands.js";
import {
  createTelegramStickerInspectCommand,
  createTelegramStickerListCommand,
  createTelegramStickerSaveCommand,
  createTelegramStickerSetSaveCommand,
  createTelegramStickerSetShowCommand,
  TELEGRAM_STICKER_INSPECT_COMMAND_NAME,
  TELEGRAM_STICKER_LIST_COMMAND_NAME,
  TELEGRAM_STICKER_SAVE_COMMAND_NAME,
  TELEGRAM_STICKER_SET_SAVE_COMMAND_NAME,
  TELEGRAM_STICKER_SET_SHOW_COMMAND_NAME,
  type TelegramStickerCommandServices,
} from "../src/integrations/channels/telegram/sticker-commands.js";

const stickers: TelegramStickerItem[] = [
  {
    fileId: "file-static",
    fileUniqueId: "unique-static",
    setName: "PandaPack",
    setTitle: "Panda Pack",
    emoji: "🐼",
    stickerType: "regular",
    format: "static",
    width: 512,
    height: 512,
    sizeBytes: 123,
  },
  {
    fileId: "file-animated",
    fileUniqueId: "unique-animated",
    setName: "PandaPack",
    setTitle: "Panda Pack",
    emoji: "🎉",
    stickerType: "regular",
    format: "animated",
    width: 512,
    height: 512,
  },
  {
    fileId: "file-video",
    fileUniqueId: "unique-video",
    setName: "PandaPack",
    setTitle: "Panda Pack",
    emoji: "😂",
    stickerType: "regular",
    format: "video",
    width: 512,
    height: 512,
  },
];

class MemoryStickerStore implements TelegramStickerStore {
  readonly records: TelegramStickerRecord[] = [];

  async importStickers(input: ImportTelegramStickersInput) {
    input = normalizeTelegramStickerImport(input);
    let createdCount = 0;
    const imported = input.stickers.map((sticker) => {
      const existing = this.records.find((record) =>
        record.agentKey === input.agentKey
        && record.connectorKey === input.connectorKey
        && record.fileUniqueId === sticker.fileUniqueId
      );
      if (existing) {
        Object.assign(existing, sticker, {
          tags: [...new Set([...existing.tags, ...(input.tags ?? [])])],
          description: input.description ?? existing.description,
          updatedAt: existing.updatedAt + 1,
        });
        return existing;
      }
      createdCount += 1;
      const record: TelegramStickerRecord = {
        ...sticker,
        id: `00000000-0000-4000-8000-${String(this.records.length + 1).padStart(12, "0")}`,
        agentKey: input.agentKey,
        connectorKey: input.connectorKey,
        tags: input.tags ?? [],
        description: input.description,
        createdAt: 1,
        updatedAt: 1,
      };
      this.records.push(record);
      return record;
    });
    return {
      stickers: imported,
      createdCount,
      updatedCount: imported.length - createdCount,
    };
  }

  async getSticker(agentKey: string, id: string) {
    return this.records.find((record) => record.agentKey === agentKey && record.id === id) ?? null;
  }

  async listStickers(filter: ListTelegramStickersFilter) {
    return this.records.filter((record) =>
      record.agentKey === filter.agentKey
      && (!filter.connectorKey || record.connectorKey === filter.connectorKey)
      && (!filter.emoji || record.emoji === filter.emoji)
      && (!filter.tag || record.tags.includes(filter.tag))
      && (!filter.query || [
        record.description,
        record.setName,
        record.setTitle,
        record.emoji,
      ].some((value) => value?.toLowerCase().includes(filter.query!.toLowerCase())))
    ).slice(0, filter.limit ?? 50);
  }
}

function request(command: CommandRequest["command"], input: CommandRequest["input"], agentKey = "panda"): CommandRequest {
  return {
    command,
    input,
    scope: {
      agentKey,
      sessionId: "session-1",
      threadId: "thread-1",
      allowedCommands: [command],
    },
  };
}

function fixture() {
  const store = new MemoryStickerStore();
  const library = new TelegramStickerLibrary(store, {
    readSet: vi.fn(async () => ({
      name: "PandaPack",
      title: "Panda Pack",
      stickerType: "regular" as const,
      stickers,
    })),
  });
  const services: TelegramStickerCommandServices = {
    library,
    connectorAccounts: {
      listAccounts: vi.fn(async () => [{
        id: "connector-account-1",
        source: "telegram",
        accountKey: "bot-1",
        connectorKey: "telegram-main",
        ownerKind: "agent" as const,
        ownerIdentityId: null,
        ownerAgentKey: "panda",
        status: "enabled" as const,
        config: {},
        createdAt: 1,
        updatedAt: 1,
      }]),
    },
    conversations: {
      listConversationBindings: vi.fn(async () => [{
        source: "telegram",
        connectorKey: "telegram-main",
        externalConversationId: "1615376408",
        sessionId: "session-1",
        createdAt: 1,
        updatedAt: 1,
      }]),
    },
    messages: {
      findChannelMedia: vi.fn(async (filter) => filter.mediaId === "media-1" ? ({
        message: {} as never,
        media: {
          id: "media-1",
          source: "telegram",
          connectorKey: "telegram-main",
          mimeType: "image/webp",
          sizeBytes: 123,
          localPath: "/private/sticker.webp",
          metadata: {
            telegramMediaKind: "sticker",
            telegramFileId: "private-file-id",
            telegramFileUniqueId: "unique-static",
            setName: "PandaPack",
            emoji: "🐼",
            stickerType: "regular",
            stickerFormat: "static",
            width: 512,
            height: 512,
          },
          createdAt: 1,
        },
      }) : null),
    },
  };
  return {library, services, store};
}

describe("Telegram stickers", () => {
  it("exposes safe inbound metadata and saves it to the owning agent", async () => {
    const {services, store} = fixture();
    const inspect = createTelegramStickerInspectCommand(services);
    const inspected = await inspect.execute(request(TELEGRAM_STICKER_INSPECT_COMMAND_NAME, {
      stickerRef: "tg-in:media-1",
      connectorKey: "telegram-main",
      conversationId: "1615376408",
    }));

    expect(inspected.output).toEqual({
      ok: true,
      chat: {connectorKey: "telegram-main", conversationId: "1615376408"},
      sticker: {
        stickerRef: "tg-in:media-1",
        emoji: "🐼",
        setName: "PandaPack",
        stickerType: "regular",
        format: "static",
        width: 512,
        height: 512,
      },
    });
    expect(JSON.stringify(inspected.output)).not.toContain("private-file-id");
    expect(JSON.stringify(inspected.output)).not.toContain("/private/");

    const save = createTelegramStickerSaveCommand(services);
    const saved = await save.execute(request(TELEGRAM_STICKER_SAVE_COMMAND_NAME, {
      stickerRef: "tg-in:media-1",
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      tags: ["Celebrate"],
      description: "Panda celebration",
    }));
    expect(saved.output).toMatchObject({
      sticker: {
        ref: "tg-lib:00000000-0000-4000-8000-000000000001",
        tags: ["celebrate"],
        description: "Panda celebration",
      },
    });
    expect(store.records[0]).toMatchObject({
      agentKey: "panda",
      fileId: "private-file-id",
      fileUniqueId: "unique-static",
    });
  });

  it("discovers a pack, imports a selected sticker, and lists only agent-owned refs", async () => {
    const {services, store} = fixture();
    const show = createTelegramStickerSetShowCommand(services);
    const shown = await show.execute(request(TELEGRAM_STICKER_SET_SHOW_COMMAND_NAME, {
      setName: "PandaPack",
      connectorKey: "telegram-main",
    }));
    expect(shown.output).toMatchObject({
      set: {
        name: "PandaPack",
        count: 3,
        stickers: [
          {stickerRef: buildTelegramStickerSetItemRef("PandaPack", "unique-static"), format: "static"},
          {stickerRef: buildTelegramStickerSetItemRef("PandaPack", "unique-animated"), format: "animated"},
          {stickerRef: buildTelegramStickerSetItemRef("PandaPack", "unique-video"), format: "video"},
        ],
      },
    });
    expect(JSON.stringify(shown.output)).not.toContain("file-static");
    expect(JSON.stringify(shown.output)).not.toContain("unique-static");

    const save = createTelegramStickerSetSaveCommand(services);
    await save.execute(request(TELEGRAM_STICKER_SET_SAVE_COMMAND_NAME, {
      setName: "PandaPack",
      connectorKey: "telegram-main",
      stickerRefs: [buildTelegramStickerSetItemRef("PandaPack", "unique-video")],
      tags: ["laugh"],
    }));
    await store.importStickers({
      agentKey: "other-agent",
      connectorKey: "telegram-main",
      stickers: [stickers[0]!],
      tags: ["hidden"],
    });

    const list = createTelegramStickerListCommand(services);
    const listed = await list.execute(request(TELEGRAM_STICKER_LIST_COMMAND_NAME, {
      tag: "laugh",
    }));
    expect(listed.output).toMatchObject({
      count: 1,
      stickers: [{
        ref: "tg-lib:00000000-0000-4000-8000-000000000001",
        format: "video",
        tags: ["laugh"],
      }],
    });
    expect(JSON.stringify(listed.output)).not.toContain("file-video");
  });

  it("sends a saved sticker by private Telegram file id without exposing it", async () => {
    const {library, services} = fixture();
    const saved = await library.saveSticker({
      agentKey: "panda",
      connectorKey: "telegram-main",
      sticker: stickers[1]!,
    });
    const actions: unknown[] = [];
    const command = createTelegramStickerSendCommand({
      enqueueAction: vi.fn(async (action) => {
        actions.push(action);
      }),
      listConversationBindings: services.conversations.listConversationBindings,
    }, {
      resolveReadablePath: vi.fn(),
    }, library);
    const result = await command.execute(request(TELEGRAM_STICKER_SEND_COMMAND_NAME, {
      connectorKey: "telegram-main",
      conversationId: "1615376408",
      stickerRef: buildTelegramStickerLibraryRef(saved.id),
    }));

    expect(result.output).toMatchObject({sticker: {type: "library_ref"}, queued: true});
    expect(JSON.stringify(result.output)).not.toContain("file-animated");
    expect(actions).toEqual([expect.objectContaining({
      payload: {
        conversationId: "1615376408",
        sticker: {type: "file_id", fileId: "file-animated"},
      },
    })]);
  });

  it("rejects pack selections that disappeared before import", async () => {
    const {library} = fixture();
    await expect(library.saveSet({
      agentKey: "panda",
      connectorKey: "telegram-main",
      setName: "PandaPack",
      stickerRefs: ["tg-set:aaaaaaaaaaaaaaaaaaaaaa"],
    })).rejects.toThrow("no longer contains every requested sticker");
  });
});
