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

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (pool) {
        await pool.end();
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

  it("rejects unsupported item types before any Discord API call", async () => {
    const {adapter, createMessage} = createAdapter();

    await expect(adapter.send(baseRequest({
      items: [
        {type: "text", text: "safe"},
        {type: "image", path: "/tmp/private.png"},
      ],
    }))).rejects.toThrow("text items only");

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
