import {describe, expect, it, vi} from "vitest";

import type {CommandRequest} from "../src/domain/commands/types.js";
import type {SecretCrypto} from "../src/domain/secrets/crypto.js";
import {
  createDiscordStickerListCommand,
  createDiscordStickerSendCommand,
  DISCORD_STICKER_LIST_COMMAND_NAME,
  DISCORD_STICKER_SEND_COMMAND_NAME,
} from "../src/integrations/channels/discord/commands.js";
import {createDiscordStickerCatalogReader, sendDiscordStickerAction} from "../src/integrations/channels/discord/stickers.js";

function request(command: string, input: CommandRequest["input"]): CommandRequest {
  return {
    command,
    input,
    scope: {
      agentKey: "panda",
      sessionId: "session-1",
      threadId: "thread-1",
      allowedCommands: [command],
    },
  };
}

const listConversationBindings = vi.fn(async () => [{
  source: "discord",
  connectorKey: "discord-main",
  externalConversationId: "12345",
  sessionId: "session-1",
  createdAt: 1,
  updatedAt: 1,
}]);

describe("Discord sticker commands", () => {
  it("checks the current-session binding before live guild sticker discovery", async () => {
    const listGuildStickersForChannel = vi.fn(async () => ({
      guildId: "99999",
      stickers: [{
        id: "67890",
        name: "party",
        description: "Party panda",
        tags: "party,panda",
        formatType: 3 as const,
        available: true,
      }],
    }));
    const command = createDiscordStickerListCommand({
      conversations: {listConversationBindings},
      stickers: {listGuildStickersForChannel},
    });

    const result = await command.execute(request(DISCORD_STICKER_LIST_COMMAND_NAME, {
      connectorKey: "discord-main",
      channelId: "12345",
    }));

    expect(listGuildStickersForChannel).toHaveBeenCalledWith({connectorKey: "discord-main", channelId: "12345"});
    expect(result.output).toEqual({
      ok: true,
      guildId: "99999",
      count: 1,
      stickers: [{
        id: "67890",
        name: "party",
        description: "Party panda",
        tags: "party,panda",
        format: "lottie",
        available: true,
      }],
    });
  });

  it("does not call Discord when the channel is not bound", async () => {
    const listGuildStickersForChannel = vi.fn();
    const command = createDiscordStickerListCommand({
      conversations: {listConversationBindings: vi.fn(async () => [])},
      stickers: {listGuildStickersForChannel},
    });

    await expect(command.execute(request(DISCORD_STICKER_LIST_COMMAND_NAME, {
      connectorKey: "discord-main",
      channelId: "12345",
    }))).rejects.toThrow("not bound to the current session");
    expect(listGuildStickersForChannel).not.toHaveBeenCalled();
  });

  it("queues one to three native sticker ids with thread and reply context", async () => {
    const enqueueAction = vi.fn(async () => ({id: "action-1"}));
    const command = createDiscordStickerSendCommand({listConversationBindings, enqueueAction});

    const result = await command.execute(request(DISCORD_STICKER_SEND_COMMAND_NAME, {
      connectorKey: "discord-main",
      conversationId: "12345",
      threadId: "23456",
      guildId: "34567",
      replyToMessageId: "45678",
      stickerIds: ["56789", "67890"],
    }));

    expect(enqueueAction).toHaveBeenCalledWith({
      sessionId: "session-1",
      threadId: "thread-1",
      channel: "discord",
      connectorKey: "discord-main",
      kind: "discord_sticker_send",
      payload: {
        parentChannelId: "12345",
        threadId: "23456",
        guildId: "34567",
        replyToMessageId: "45678",
        stickerIds: ["56789", "67890"],
      },
    });
    expect(result.output).toEqual({ok: true, status: "queued", actionId: "action-1", stickerCount: 2});
  });

  it("rejects an invalid sticker count before queueing", async () => {
    const enqueueAction = vi.fn();
    const command = createDiscordStickerSendCommand({listConversationBindings, enqueueAction});
    await expect(command.execute(request(DISCORD_STICKER_SEND_COMMAND_NAME, {
      connectorKey: "discord-main",
      conversationId: "12345",
      stickerIds: [],
    }))).rejects.toThrow("1-3 sticker ids");
    expect(enqueueAction).not.toHaveBeenCalled();
  });
});

describe("Discord sticker API service", () => {
  it("decrypts credentials only after command authority and resolves the channel guild", async () => {
    const client = {
      getChannelMetadata: vi.fn(async () => ({id: "12345", type: 0, guildId: "99999"})),
      listGuildStickers: vi.fn(async () => []),
    };
    const reader = createDiscordStickerCatalogReader({
      accounts: {
        listAccounts: vi.fn(async () => [{
          id: "account-1",
          source: "discord",
          accountKey: "ops",
          connectorKey: "discord-main",
          ownerKind: "agent" as const,
          ownerIdentityId: null,
          ownerAgentKey: "panda",
          status: "enabled" as const,
          config: {},
          createdAt: 1,
          updatedAt: 1,
        }]),
        getSecret: vi.fn(async () => "private-bot-token"),
      },
      client,
      crypto: {} as SecretCrypto,
    });

    await expect(reader.listGuildStickersForChannel({connectorKey: "discord-main", channelId: "12345"}))
      .resolves.toEqual({guildId: "99999", stickers: []});
    expect(client.getChannelMetadata).toHaveBeenCalledWith("private-bot-token", "12345");
    expect(client.listGuildStickers).toHaveBeenCalledWith("private-bot-token", "99999");
  });

  it("sends sticker ids natively with mention-safe reply context", async () => {
    const createMessage = vi.fn(async () => ({id: "message-1"}));
    await sendDiscordStickerAction({
      parentChannelId: "12345",
      threadId: "23456",
      guildId: "34567",
      replyToMessageId: "45678",
      stickerIds: ["56789"],
    }, {botToken: "private-bot-token", client: {createMessage}});

    expect(createMessage).toHaveBeenCalledWith("private-bot-token", "23456", {
      allowed_mentions: {parse: []},
      sticker_ids: ["56789"],
      message_reference: {
        message_id: "45678",
        channel_id: "23456",
        guild_id: "34567",
        fail_if_not_exists: false,
      },
    });
  });
});
