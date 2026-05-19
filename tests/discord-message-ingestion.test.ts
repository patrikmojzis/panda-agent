import {describe, expect, it, vi} from "vitest";

import type {ConversationBinding} from "../src/domain/sessions/conversations/types.js";
import {
  createDefaultDiscordBoundMessageHandler,
  ingestDiscordMessageCreate,
  type DiscordMessageCreatePayload,
} from "../src/integrations/channels/discord/message-ingestion.js";

function binding(overrides: Partial<ConversationBinding> = {}): ConversationBinding {
  return {
    source: "discord",
    connectorKey: "bot-1",
    externalConversationId: "channel-1",
    sessionId: "session-1",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function messagePayload(overrides: DiscordMessageCreatePayload = {}): DiscordMessageCreatePayload {
  return {
    id: "message-1",
    channel_id: "channel-1",
    guild_id: "guild-1",
    author: {
      id: "user-1",
    },
    content: "PRIVATE_SENTINEL_TEXT",
    timestamp: "2026-05-18T19:00:00.000Z",
    attachments: [
      {
        id: "attachment-1",
        filename: "private-file-name.png",
        content_type: "image/png",
        size: 123,
        url: "https://cdn.example/private-url",
        ["proxy_" + "url"]: "https://cdn.example/private-proxy-url",
      },
    ],
    ...overrides,
  };
}

function stringifyLogCalls(log: ReturnType<typeof vi.fn>): string {
  return JSON.stringify(log.mock.calls);
}

describe("Discord message ingestion privacy preflight", () => {
  it("drops unbound thread messages after safe parent binding lookup without leaking content, attachments, or author display fields", async () => {
    const log = vi.fn();
    const onBoundMessage = vi.fn();
    const downloadAttachments = vi.fn();
    const getConversationBinding = vi.fn(async () => null);
    const payload = messagePayload({
      channel_id: "thread-1",
      author: {
        id: "user-1",
        username: "PRIVATE_USERNAME",
        global_name: "PRIVATE_GLOBAL_NAME",
        display_name: "PRIVATE_DISPLAY_NAME",
      },
    });

    const result = await ingestDiscordMessageCreate(payload, {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding},
      downloadAttachments,
      log,
      onBoundMessage,
      resolveParentChannelId: vi.fn(async () => ({
        parentChannelId: "channel-1",
        threadId: "thread-1",
        guildId: "guild-1",
      })),
    });

    expect(result).toEqual({status: "dropped", reason: "unbound_conversation"});
    expect(getConversationBinding).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
    });
    expect(onBoundMessage).not.toHaveBeenCalled();
    expect(downloadAttachments).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("message_dropped", expect.objectContaining({
      reason: "unbound_conversation",
      connectorKey: "bot-1",
      accountKey: "ops",
      externalConversationId: "channel-1",
      actualChannelId: "thread-1",
      threadId: "thread-1",
      externalMessageId: "message-1",
    }));

    const logs = stringifyLogCalls(log);
    expect(logs).not.toContain("PRIVATE_SENTINEL_TEXT");
    expect(logs).not.toContain("private-file-name.png");
    expect(logs).not.toContain("https://cdn.example/private-url");
    expect(logs).not.toContain("https://cdn.example/private-proxy-url");
    expect(logs).not.toContain("PRIVATE_USERNAME");
    expect(logs).not.toContain("PRIVATE_GLOBAL_NAME");
    expect(logs).not.toContain("PRIVATE_DISPLAY_NAME");
  });

  it("calls the bound callback with a locked runtime request payload, not the raw Gateway payload", async () => {
    const onBoundMessage = vi.fn();
    const foundBinding = binding();

    const result = await ingestDiscordMessageCreate(messagePayload({
      author: {
        id: "user-1",
        username: "patrik",
        global_name: "Patrik Global",
        display_name: "Patrik Display",
        bot: false,
      },
      message_reference: {
        message_id: "reply-1",
      },
      embeds: [{title: "private embed"}],
    }), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {
        getConversationBinding: vi.fn(async () => foundBinding),
      },
      log: vi.fn(),
      onBoundMessage,
      resolveParentChannelId: vi.fn(async () => ({
        parentChannelId: "channel-1",
        guildId: "guild-1",
      })),
    });

    expect(result.status).toBe("bound");
    expect(onBoundMessage).toHaveBeenCalledWith({
      binding: foundBinding,
      requestPayload: expect.objectContaining({
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        externalActorId: "user-1",
        externalMessageId: "message-1",
        actualChannelId: "channel-1",
        parentChannelId: "channel-1",
        guildId: "guild-1",
        text: "PRIVATE_SENTINEL_TEXT",
        sentAt: Date.parse("2026-05-18T19:00:00.000Z"),
        authorUsername: "patrik",
        authorGlobalName: "Patrik Global",
        authorDisplayName: "Patrik Display",
        authorIsBot: false,
        replyToMessageId: "reply-1",
        deliveryContext: {
          discord: {
            channelId: "channel-1",
            parentChannelId: "channel-1",
            guildId: "guild-1",
            messageId: "message-1",
            referencedMessageId: "reply-1",
          },
        },
        attachmentSummaries: [{
          id: "attachment-1",
          filename: "private-file-name.png",
          contentType: "image/png",
          sizeBytes: 123,
        }],
      }),
      route: expect.objectContaining({
        source: "discord",
        connectorKey: "bot-1",
        accountKey: "ops",
        externalConversationId: "channel-1",
        actualChannelId: "channel-1",
        externalMessageId: "message-1",
      }),
    });
    const callbackPayload = JSON.stringify(onBoundMessage.mock.calls[0]?.[0]);
    expect(onBoundMessage.mock.calls[0]?.[0]?.requestPayload.deliveryContext).not.toHaveProperty(
      "discord.replyTargetMessageId",
    );
    expect(callbackPayload).not.toContain("payload");
    expect(callbackPayload).not.toContain("url");
    expect(callbackPayload).not.toContain("proxy_" + "url");
    expect(callbackPayload).not.toContain("private embed");
  });

  it("ignores self-authored messages before resolving parents or checking bindings", async () => {
    const resolveParentChannelId = vi.fn(async () => ({parentChannelId: "channel-1"}));
    const getConversationBinding = vi.fn(async () => binding());
    const onBoundMessage = vi.fn();

    const result = await ingestDiscordMessageCreate(messagePayload({
      author: {
        id: "bot-1",
      },
    }), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding},
      log: vi.fn(),
      onBoundMessage,
      resolveParentChannelId,
    });

    expect(result).toEqual({status: "ignored", reason: "own_message"});
    expect(resolveParentChannelId).not.toHaveBeenCalled();
    expect(getConversationBinding).not.toHaveBeenCalled();
    expect(onBoundMessage).not.toHaveBeenCalled();
  });

  it("drops safely when parent channel cannot be resolved", async () => {
    const log = vi.fn();
    const getConversationBinding = vi.fn(async () => binding());
    const onBoundMessage = vi.fn();

    const result = await ingestDiscordMessageCreate(messagePayload({
      channel_id: "thread-without-parent",
    }), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding},
      log,
      onBoundMessage,
      resolveParentChannelId: vi.fn(async () => null),
    });

    expect(result).toEqual({status: "dropped", reason: "unresolved_parent_channel"});
    expect(getConversationBinding).not.toHaveBeenCalled();
    expect(onBoundMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("message_dropped", expect.objectContaining({
      reason: "unresolved_parent_channel",
      actualChannelId: "thread-without-parent",
      externalMessageId: "message-1",
    }));
    expect(stringifyLogCalls(log)).not.toContain("PRIVATE_SENTINEL_TEXT");
  });

  it("binds normal channels by actual channel id and thread requests by parent channel id", async () => {
    const getConversationBinding = vi.fn(async (lookup) => binding({
      externalConversationId: lookup.externalConversationId,
    }));
    const onBoundMessage = vi.fn();

    await ingestDiscordMessageCreate(messagePayload({id: "normal-message", channel_id: "channel-1"}), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding},
      log: vi.fn(),
      onBoundMessage,
      resolveParentChannelId: vi.fn(async () => ({parentChannelId: "channel-1"})),
    });
    await ingestDiscordMessageCreate(messagePayload({id: "thread-message", channel_id: "thread-1"}), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding},
      log: vi.fn(),
      onBoundMessage,
      resolveParentChannelId: vi.fn(async () => ({
        parentChannelId: "channel-1",
        threadId: "thread-1",
      })),
    });

    expect(getConversationBinding).toHaveBeenNthCalledWith(1, {
      source: "discord",
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
    });
    expect(getConversationBinding).toHaveBeenNthCalledWith(2, {
      source: "discord",
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
    });
    expect(onBoundMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      requestPayload: expect.objectContaining({
        actualChannelId: "thread-1",
        threadId: "thread-1",
        externalConversationId: "channel-1",
        deliveryContext: {
          discord: {
            channelId: "thread-1",
            parentChannelId: "channel-1",
            threadId: "thread-1",
            guildId: "guild-1",
            messageId: "thread-message",
          },
        },
      }),
      route: expect.objectContaining({
        actualChannelId: "thread-1",
        threadId: "thread-1",
        externalConversationId: "channel-1",
      }),
    }));
  });

  it("drops messages without author ids before parent lookup or queue", async () => {
    const resolveParentChannelId = vi.fn(async () => ({parentChannelId: "channel-1"}));
    const getConversationBinding = vi.fn(async () => binding());
    const onBoundMessage = vi.fn();

    const result = await ingestDiscordMessageCreate(messagePayload({
      author: {},
    }), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding},
      log: vi.fn(),
      onBoundMessage,
      resolveParentChannelId,
    });

    expect(result).toEqual({status: "dropped", reason: "invalid_message"});
    expect(resolveParentChannelId).not.toHaveBeenCalled();
    expect(getConversationBinding).not.toHaveBeenCalled();
    expect(onBoundMessage).not.toHaveBeenCalled();
  });

  it("drops embed-only unsupported shapes after binding using only safe route logs", async () => {
    const log = vi.fn();
    const onBoundMessage = vi.fn();

    const result = await ingestDiscordMessageCreate(messagePayload({
      content: " ",
      attachments: [],
      embeds: [{title: "PRIVATE_EMBED_TITLE"}],
    }), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding: vi.fn(async () => binding())},
      log,
      onBoundMessage,
      resolveParentChannelId: vi.fn(async () => ({parentChannelId: "channel-1"})),
    });

    expect(result).toEqual({status: "dropped", reason: "unsupported_message_shape"});
    expect(onBoundMessage).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("message_dropped", expect.objectContaining({
      reason: "unsupported_message_shape",
      externalConversationId: "channel-1",
      externalMessageId: "message-1",
    }));
    expect(stringifyLogCalls(log)).not.toContain("PRIVATE_EMBED_TITLE");
  });

  it("queues attachment-only bound messages as attachment summaries without raw media URLs", async () => {
    const onBoundMessage = vi.fn();

    const result = await ingestDiscordMessageCreate(messagePayload({
      content: " ",
      attachments: [{
        id: "attachment-2",
        filename: "report.pdf",
        content_type: "application/pdf",
        size: 456,
        url: "https://cdn.example/private-report",
      }],
    }), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding: vi.fn(async () => binding())},
      log: vi.fn(),
      onBoundMessage,
      resolveParentChannelId: vi.fn(async () => ({parentChannelId: "channel-1"})),
    });

    expect(result.status).toBe("bound");
    const callbackPayload = onBoundMessage.mock.calls[0]?.[0]?.requestPayload;
    expect(callbackPayload).toMatchObject({
      attachmentSummaries: [{
        id: "attachment-2",
        filename: "report.pdf",
        contentType: "application/pdf",
        sizeBytes: 456,
      }],
    });
    expect(callbackPayload).not.toHaveProperty("text");
    expect(JSON.stringify(onBoundMessage.mock.calls[0]?.[0])).not.toContain("https://cdn.example/private-report");
  });

  it("downloads attachments only after a binding is found and queues only successful media", async () => {
    const media = [{
      id: "media-1",
      source: "discord",
      connectorKey: "bot-1",
      mimeType: "image/png",
      sizeBytes: 5,
      localPath: "/tmp/discord-media.png",
      originalFilename: "image.png",
      metadata: {discordAttachmentId: "attachment-1"},
      createdAt: 1,
    }];
    const downloadAttachments = vi.fn(async () => ({
      media,
      unavailable: [{
        id: "attachment-2",
        contentType: "image/png",
        reason: "Discord attachment download failed.",
      }],
    }));
    const onBoundMessage = vi.fn();

    const result = await ingestDiscordMessageCreate(messagePayload({
      content: " ",
      attachments: [
        {
          id: "attachment-1",
          filename: "image.png",
          content_type: "image/png",
          size: 5,
          url: "https://cdn.discordapp.com/attachments/channel/attachment/image.png",
        },
        {
          id: "attachment-2",
          filename: "failed.png",
          content_type: "image/png",
          size: 5,
          url: "https://cdn.discordapp.com/attachments/channel/attachment/failed.png",
        },
      ],
    }), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding: vi.fn(async () => binding())},
      downloadAttachments,
      log: vi.fn(),
      onBoundMessage,
      resolveParentChannelId: vi.fn(async () => ({parentChannelId: "channel-1"})),
    });

    expect(result.status).toBe("bound");
    expect(downloadAttachments).toHaveBeenCalledOnce();
    expect(onBoundMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestPayload: expect.objectContaining({
        attachmentSummaries: [
          expect.objectContaining({id: "attachment-1"}),
          expect.objectContaining({id: "attachment-2"}),
        ],
        media,
      }),
    }));
    expect(JSON.stringify(onBoundMessage.mock.calls[0]?.[0])).not.toContain("cdn.discordapp.com");
  });

  it("keeps bound messages when attachment download fails before returning a result", async () => {
    const onBoundMessage = vi.fn();

    const result = await ingestDiscordMessageCreate(messagePayload({
      content: "message survives",
      attachments: [{
        id: "attachment-1",
        filename: "image.png",
        content_type: "image/png",
        size: 5,
        url: "https://cdn.discordapp.com/attachments/channel/attachment/image.png",
      }],
    }), {
      accountKey: "ops",
      connectorKey: "bot-1",
      conversationRepo: {getConversationBinding: vi.fn(async () => binding())},
      downloadAttachments: vi.fn(async () => {
        throw new Error("unexpected downloader failure");
      }),
      log: vi.fn(),
      onBoundMessage,
      resolveParentChannelId: vi.fn(async () => ({parentChannelId: "channel-1"})),
    });

    expect(result.status).toBe("bound");
    expect(onBoundMessage).toHaveBeenCalledWith(expect.objectContaining({
      requestPayload: expect.objectContaining({
        text: "message survives",
        attachmentSummaries: [expect.objectContaining({id: "attachment-1"})],
        media: [],
      }),
    }));
  });

  it("default bound callback logs only safe route ids and drops", async () => {
    const log = vi.fn();
    const handler = createDefaultDiscordBoundMessageHandler(log);

    await handler({
      binding: binding(),
      requestPayload: {
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        externalActorId: "user-1",
        externalMessageId: "message-1",
        actualChannelId: "channel-1",
        text: "PRIVATE_SENTINEL_TEXT",
        attachmentSummaries: [],
        media: [],
      },
      route: {
        source: "discord",
        connectorKey: "bot-1",
        accountKey: "ops",
        externalConversationId: "channel-1",
        actualChannelId: "channel-1",
        externalMessageId: "message-1",
      },
    });

    expect(log).toHaveBeenCalledWith("message_preflight_bound", expect.objectContaining({
      reason: "bound_callback_not_configured",
      externalConversationId: "channel-1",
      externalMessageId: "message-1",
    }));
    expect(stringifyLogCalls(log)).not.toContain("PRIVATE_SENTINEL_TEXT");
  });
});
