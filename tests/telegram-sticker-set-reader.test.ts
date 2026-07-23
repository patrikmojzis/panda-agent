import {describe, expect, it, vi} from "vitest";

import {createTelegramStickerSetReader} from "../src/integrations/channels/telegram/sticker-set-reader.js";

function account() {
  return {
    id: "account-1",
    source: "telegram",
    accountKey: "main",
    connectorKey: "telegram-main",
    ownerKind: "agent" as const,
    ownerIdentityId: null,
    ownerAgentKey: "panda",
    status: "enabled" as const,
    config: {},
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("Telegram sticker set reader", () => {
  it("normalizes static, animated, and video sticker metadata", async () => {
    const getStickerSet = vi.fn(async () => ({
      name: "PandaPack",
      title: "Panda Pack",
      sticker_type: "regular" as const,
      stickers: [
        {
          file_id: "static-id",
          file_unique_id: "static-unique",
          type: "regular" as const,
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
        },
        {
          file_id: "animated-id",
          file_unique_id: "animated-unique",
          type: "regular" as const,
          width: 512,
          height: 512,
          is_animated: true,
          is_video: false,
        },
        {
          file_id: "video-id",
          file_unique_id: "video-unique",
          type: "regular" as const,
          width: 512,
          height: 512,
          is_animated: false,
          is_video: true,
        },
      ],
    }));
    const reader = createTelegramStickerSetReader({
      accounts: {
        getAccountByConnectorKey: vi.fn(async () => account()),
        getSecret: vi.fn(async () => "12345678:private-token"),
      },
      crypto: {} as never,
      createApi: () => ({getStickerSet} as never),
    });

    await expect(reader.readSet("telegram-main", "PandaPack")).resolves.toMatchObject({
      name: "PandaPack",
      stickers: [
        {fileUniqueId: "static-unique", format: "static"},
        {fileUniqueId: "animated-unique", format: "animated"},
        {fileUniqueId: "video-unique", format: "video"},
      ],
    });
  });

  it("redacts the bot token from Telegram API failures", async () => {
    const token = "12345678:private-token";
    const reader = createTelegramStickerSetReader({
      accounts: {
        getAccountByConnectorKey: vi.fn(async () => account()),
        getSecret: vi.fn(async () => token),
      },
      crypto: {} as never,
      createApi: () => ({
        getStickerSet: vi.fn(async () => {
          throw new Error(`Telegram rejected ${token}`);
        }),
      } as never),
    });

    const error = await reader.readSet("telegram-main", "deleted_pack").then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain("[redacted]");
    expect(error?.message).not.toContain(token);
  });

  it("rejects unavailable connectors before touching Telegram", async () => {
    const getStickerSet = vi.fn();
    const reader = createTelegramStickerSetReader({
      accounts: {
        getAccountByConnectorKey: vi.fn(async () => null),
        getSecret: vi.fn(),
      },
      crypto: null,
      createApi: () => ({getStickerSet} as never),
    });

    await expect(reader.readSet("missing", "PandaPack")).rejects.toThrow(
      "No enabled Telegram connector missing is available.",
    );
    expect(getStickerSet).not.toHaveBeenCalled();
  });
});
