import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {ChannelOutboundDeliveryWorker} from "../src/domain/channels/deliveries/worker.js";
import {PostgresOutboundDeliveryStore} from "../src/domain/channels/deliveries/postgres.js";
import type {OutboundRequest} from "../src/domain/channels/types.js";
import {DISCORD_MESSAGE_CONTENT_LIMIT} from "../src/integrations/channels/discord/config.js";
import {createDiscordOutboundAdapter} from "../src/integrations/channels/discord/outbound.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

const privateToken = "discord-private-token-fragment-12345678";

function baseRequest(overrides: Partial<OutboundRequest> = {}): OutboundRequest {
  return {
    channel: "discord",
    target: {
      source: "discord",
      connectorKey: "bot-1",
      externalConversationId: "channel-1",
    },
    items: [{type: "text", text: "hello"}],
    ...overrides,
  };
}

function createAdapter(createMessage = vi.fn(async () => ({id: "message-1"}))) {
  return {
    adapter: createDiscordOutboundAdapter({
      botToken: privateToken,
      client: {createMessage},
      connectorKey: "bot-1",
    }),
    createMessage,
  };
}

describe("Discord outbound adapter", () => {
  const pools: Array<{end(): Promise<void>}> = [];
  const tempDirs: string[] = [];

  async function writeTempUpload(filename: string, bytes: Buffer): Promise<{filePath: string; bytes: Buffer}> {
    const dir = await mkdtemp(path.join(tmpdir(), "discord-outbound-"));
    tempDirs.push(dir);
    const filePath = path.join(dir, filename);
    await writeFile(filePath, bytes);
    return {filePath, bytes};
  }

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) {
        await pool.end();
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        await rm(dir, {recursive: true, force: true});
      }
    }
  });

  it("sends text-only messages to the target channel with mention parsing disabled", async () => {
    const {adapter, createMessage} = createAdapter();

    const result = await adapter.send(baseRequest());

    expect(createMessage).toHaveBeenCalledWith(privateToken, "channel-1", {
      content: "hello",
      allowed_mentions: {parse: []},
    });
    expect(createMessage.mock.calls[0]).toHaveLength(3);
    expect(result).toEqual({
      ok: true,
      channel: "discord",
      target: baseRequest().target,
      sent: [{type: "text", externalMessageId: "message-1"}],
    });
  });

  it("sends multiple text items in order and returns one sent id per item", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({id: "message-1"})
      .mockResolvedValueOnce({id: "message-2"});
    const {adapter} = createAdapter(createMessage);

    const result = await adapter.send(baseRequest({
      items: [
        {type: "text", text: "first"},
        {type: "text", text: "second"},
      ],
    }));

    expect(createMessage.mock.calls.map((call) => call[2].content)).toEqual(["first", "second"]);
    expect(result.sent).toEqual([
      {type: "text", externalMessageId: "message-1"},
      {type: "text", externalMessageId: "message-2"},
    ]);
  });

  it("sends image items as multipart uploads with captions", async () => {
    const {adapter, createMessage} = createAdapter();
    const upload = await writeTempUpload("photo.png", Buffer.from("fake-image"));

    const result = await adapter.send(baseRequest({
      items: [{type: "image", path: upload.filePath, caption: "look here"}],
    }));

    expect(createMessage).toHaveBeenCalledWith(privateToken, "channel-1", {
      content: "look here",
      allowed_mentions: {parse: []},
    }, [{
      filename: "photo.png",
      bytes: upload.bytes,
    }]);
    expect(result.sent).toEqual([{type: "image", externalMessageId: "message-1"}]);
  });

  it("sends file items as multipart uploads with explicit filename, mime type, and caption", async () => {
    const {adapter, createMessage} = createAdapter();
    const upload = await writeTempUpload("report-source.bin", Buffer.from("fake-report"));

    const result = await adapter.send(baseRequest({
      items: [{
        type: "file",
        path: upload.filePath,
        filename: "report.pdf",
        mimeType: "application/pdf",
        caption: "report attached",
      }],
    }));

    expect(createMessage).toHaveBeenCalledWith(privateToken, "channel-1", {
      content: "report attached",
      allowed_mentions: {parse: []},
    }, [{
      filename: "report.pdf",
      bytes: upload.bytes,
      mimeType: "application/pdf",
    }]);
    expect(result.sent).toEqual([{type: "file", externalMessageId: "message-1"}]);
  });

  it("preserves mixed item order and applies reply references only to the first item", async () => {
    const image = await writeTempUpload("first.png", Buffer.from("image-one"));
    const file = await writeTempUpload("notes.txt", Buffer.from("file-two"));
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({id: "message-1"})
      .mockResolvedValueOnce({id: "message-2"})
      .mockResolvedValueOnce({id: "message-3"});
    const {adapter} = createAdapter(createMessage);

    const result = await adapter.send(baseRequest({
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        replyToMessageId: "reply-1",
        deliveryContext: {
          discord: {
            channelId: "thread-1",
            parentChannelId: "channel-1",
            threadId: "thread-1",
            guildId: "guild-1",
          },
        },
      },
      items: [
        {type: "image", path: image.filePath},
        {type: "text", text: "middle"},
        {type: "file", path: file.filePath},
      ],
    }));

    expect(createMessage).toHaveBeenNthCalledWith(1, privateToken, "thread-1", {
      allowed_mentions: {parse: []},
      message_reference: {
        message_id: "reply-1",
        channel_id: "thread-1",
        guild_id: "guild-1",
        fail_if_not_exists: false,
      },
    }, [{
      filename: "first.png",
      bytes: image.bytes,
    }]);
    expect(createMessage).toHaveBeenNthCalledWith(2, privateToken, "thread-1", {
      content: "middle",
      allowed_mentions: {parse: []},
    });
    expect(createMessage.mock.calls[1]).toHaveLength(3);
    expect(createMessage).toHaveBeenNthCalledWith(3, privateToken, "thread-1", {
      allowed_mentions: {parse: []},
    }, [{
      filename: "notes.txt",
      bytes: file.bytes,
      mimeType: "application/octet-stream",
    }]);
    expect(result.sent).toEqual([
      {type: "image", externalMessageId: "message-1"},
      {type: "text", externalMessageId: "message-2"},
      {type: "file", externalMessageId: "message-3"},
    ]);
  });

  it("rejects unreadable media paths before any Discord API call", async () => {
    const {adapter, createMessage} = createAdapter();
    const dir = await mkdtemp(path.join(tmpdir(), "discord-outbound-missing-"));
    tempDirs.push(dir);

    await expect(adapter.send(baseRequest({
      items: [{type: "file", path: path.join(dir, "missing.txt")}],
    }))).rejects.toThrow();

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("rejects channel, source, and connector mismatches before any Discord API call", async () => {
    const {adapter, createMessage} = createAdapter();

    await expect(adapter.send(baseRequest({channel: "telegram"}))).rejects.toThrow("channel discord");
    await expect(adapter.send(baseRequest({
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
      },
    }))).rejects.toThrow("target source must be discord");
    await expect(adapter.send(baseRequest({
      target: {
        source: "discord",
        connectorKey: "bot-2",
        externalConversationId: "channel-1",
      },
    }))).rejects.toThrow("connector key does not match");

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("sends Discord thread-context text to the thread id, not the parent lane", async () => {
    const {adapter, createMessage} = createAdapter();

    await adapter.send(baseRequest({
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        deliveryContext: {
          discord: {
            channelId: "thread-1",
            parentChannelId: "channel-1",
            threadId: "thread-1",
            guildId: "guild-1",
          },
        },
      },
    }));

    expect(createMessage).toHaveBeenCalledWith(privateToken, "thread-1", {
      content: "hello",
      allowed_mentions: {parse: []},
    });
  });

  it("sends Discord channel-context text to the parent channel id", async () => {
    const {adapter, createMessage} = createAdapter();

    await adapter.send(baseRequest({
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        deliveryContext: {
          discord: {
            channelId: "channel-1",
            parentChannelId: "channel-1",
            guildId: "guild-1",
          },
        },
      },
    }));

    expect(createMessage).toHaveBeenCalledWith(privateToken, "channel-1", {
      content: "hello",
      allowed_mentions: {parse: []},
    });
  });

  it("applies explicit Discord reply references only to the first text item", async () => {
    const createMessage = vi
      .fn()
      .mockResolvedValueOnce({id: "message-1"})
      .mockResolvedValueOnce({id: "message-2"});
    const {adapter} = createAdapter(createMessage);

    await adapter.send(baseRequest({
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        replyToMessageId: "explicit-reply-1",
        deliveryContext: {
          discord: {
            channelId: "thread-1",
            parentChannelId: "channel-1",
            threadId: "thread-1",
            guildId: "guild-1",
            replyTargetMessageId: "context-reply-ignored",
          },
        },
      },
      items: [
        {type: "text", text: "first"},
        {type: "text", text: "second"},
      ],
    }));

    expect(createMessage).toHaveBeenNthCalledWith(1, privateToken, "thread-1", {
      content: "first",
      allowed_mentions: {parse: []},
      message_reference: {
        message_id: "explicit-reply-1",
        channel_id: "thread-1",
        guild_id: "guild-1",
        fail_if_not_exists: false,
      },
    });
    expect(createMessage).toHaveBeenNthCalledWith(2, privateToken, "thread-1", {
      content: "second",
      allowed_mentions: {parse: []},
    });
  });

  it("rejects malformed or mismatched Discord delivery context before any API call", async () => {
    const {adapter, createMessage} = createAdapter();

    await expect(adapter.send(baseRequest({
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        deliveryContext: {discord: {channelId: "thread-1", parentChannelId: "other-channel"}},
      },
    }))).rejects.toThrow("parent channel does not match");
    await expect(adapter.send(baseRequest({
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        deliveryContext: {discord: {channelId: "other-channel"}},
      },
    }))).rejects.toThrow("channel id does not match");
    await expect(adapter.send(baseRequest({
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        deliveryContext: {discord: {channelId: "thread-2", threadId: "thread-1"}},
      },
    }))).rejects.toThrow("thread id does not match");
    await expect(adapter.send(baseRequest({
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
        deliveryContext: {discord: []} as never,
      },
    }))).rejects.toThrow("discord must be a JSON object");

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("rejects blank and over-limit text before any Discord API call", async () => {
    const {adapter, createMessage} = createAdapter();

    await expect(adapter.send(baseRequest({
      items: [{type: "text", text: "   "}],
    }))).rejects.toThrow("text must not be empty");
    await expect(adapter.send(baseRequest({
      items: [{type: "text", text: "x".repeat(DISCORD_MESSAGE_CONTENT_LIMIT + 1)}],
    }))).rejects.toThrow(`at most ${DISCORD_MESSAGE_CONTENT_LIMIT} characters`);

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("rejects over-limit captions before any Discord API call", async () => {
    const {adapter, createMessage} = createAdapter();
    const upload = await writeTempUpload("photo.png", Buffer.from("fake-image"));

    await expect(adapter.send(baseRequest({
      items: [{
        type: "image",
        path: upload.filePath,
        caption: "x".repeat(DISCORD_MESSAGE_CONTENT_LIMIT + 1),
      }],
    }))).rejects.toThrow(`caption must be at most ${DISCORD_MESSAGE_CONTENT_LIMIT} characters`);

    expect(createMessage).not.toHaveBeenCalled();
  });

  it("redacts bot token material from Discord API failures", async () => {
    const {adapter} = createAdapter(vi.fn(async () => {
      throw new Error(`Discord rejected ${privateToken} and 12345678`);
    }));

    try {
      await adapter.send(baseRequest());
      throw new Error("Expected Discord outbound to fail.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("[redacted]");
      expect(message).not.toContain(privateToken);
      expect(message).not.toContain("12345678");
    }
  });

  it("worker plumbing claims only Discord deliveries for the running connector", async () => {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    await createRuntimeStores(pool);
    const store = new PostgresOutboundDeliveryStore({pool});
    await store.ensureSchema();

    const discordA = await store.enqueueDelivery({
      channel: "discord",
      target: {
        source: "discord",
        connectorKey: "bot-1",
        externalConversationId: "channel-1",
      },
      items: [{type: "text", text: "for bot one"}],
    });
    const discordB = await store.enqueueDelivery({
      channel: "discord",
      target: {
        source: "discord",
        connectorKey: "bot-2",
        externalConversationId: "channel-2",
      },
      items: [{type: "text", text: "for bot two"}],
    });
    const telegramA = await store.enqueueDelivery({
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-1",
        externalConversationId: "chat-1",
      },
      items: [{type: "text", text: "wrong channel"}],
    });
    const {adapter: outboundAdapter, createMessage} = createAdapter(vi.fn(async () => ({id: "discord-message-1"})));
    const worker = new ChannelOutboundDeliveryWorker({
      store,
      adapter: outboundAdapter,
      connectorKey: "bot-1",
    });

    await worker.start({subscribeToNotifications: false});
    await worker.triggerDrain();
    await worker.stop();

    expect(createMessage).toHaveBeenCalledOnce();
    expect(await store.getDelivery(discordA.id)).toMatchObject({
      status: "sent",
      sent: [{type: "text", externalMessageId: "discord-message-1"}],
    });
    expect(await store.getDelivery(discordB.id)).toMatchObject({status: "pending"});
    expect(await store.getDelivery(telegramA.id)).toMatchObject({status: "pending"});
  });
});
