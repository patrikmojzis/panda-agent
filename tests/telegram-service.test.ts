import {afterEach, describe, expect, it, vi} from "vitest";

import {TelegramService} from "../src/integrations/channels/telegram/service.js";

const telegramServiceMocks = vi.hoisted(() => {
  const botInstances: MockBot[] = [];

  class MockBot {
    readonly api = {
      getMe: vi.fn(async () => ({
        id: 42,
        username: "panda_bot",
      })),
      setMyCommands: vi.fn(async () => {}),
      getUpdates: vi.fn(async () => []),
      setMessageReaction: vi.fn(async () => {}),
    };
    readonly on = vi.fn((event: string, handler: (ctx: unknown) => Promise<void> | void) => {
      this.handlers.set(event, handler);
      return this;
    });
    readonly handleUpdate = vi.fn(async (update: {context?: unknown}) => {
      const context = update.context;
      const event = context && typeof context === "object" && "messageReaction" in context
        ? "message_reaction"
        : "message";
      const handler = this.handlers.get(event);
      if (!handler) {
        return;
      }

      await handler(context);
    });
    botInfo?: unknown;
    private readonly handlers = new Map<string, (ctx: unknown) => Promise<void> | void>();

    constructor(_token: string) {
      botInstances.push(this);
    }
  }

  return {
    MockBot,
    botInstances,
  };
});

vi.mock("grammy", () => ({
  Bot: telegramServiceMocks.MockBot,
}));

function latestBot(): InstanceType<typeof telegramServiceMocks.MockBot> {
  const bot = telegramServiceMocks.botInstances.at(-1);
  if (!bot) {
    throw new Error("Expected a mocked Telegram bot instance.");
  }

  return bot;
}

function createStores() {
  return {
    pool: {
      end: vi.fn(async () => {}),
    },
    channelCursors: {
      resolveChannelCursor: vi.fn(async () => null),
      upsertChannelCursor: vi.fn(async () => ({
        source: "telegram",
        connectorKey: "42",
        cursorKey: "telegram-updates",
        value: "1",
      })),
    },
    outboundDeliveries: {},
    channelActions: {},
    requests: {
      enqueueRequest: vi.fn(async () => ({
        id: "request-1",
      })),
    },
    mediaStore: {},
  } as const;
}

function createTelegramContext() {
  return {
    chat: {
      id: 777,
      type: "private",
    },
    from: {
      id: 123,
      username: "alice",
      first_name: "Alice",
      last_name: "Liddell",
    },
    msg: {
      message_id: 555,
      text: "show me the bug",
      chat: {
        id: 777,
      },
    },
  };
}

function createTelegramReactionContext(overrides: Record<string, unknown> = {}) {
  return {
    update: {
      update_id: 777001,
    },
    messageReaction: {
      chat: {
        id: 777,
        type: "private",
      },
      message_id: 555,
      user: {
        id: 123,
        username: "alice",
        first_name: "Alice",
        last_name: "Liddell",
        is_bot: false,
      },
      old_reaction: [],
      new_reaction: [{type: "emoji", emoji: "🔥"}],
    },
    ...overrides,
  };
}

describe("TelegramService", () => {
  afterEach(() => {
    telegramServiceMocks.botInstances.length = 0;
    vi.restoreAllMocks();
  });

  it("starts workers only after acquiring the connector lock", async () => {
    const stores = createStores();
    const outboundWorker = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const actionWorker = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const release = vi.fn(async () => {});
    const order: string[] = [];
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockImplementation(async () => {
      (service as {stores?: unknown}).stores = stores;
      return {
        stores,
        connectorKey: "42",
        botUsername: "panda_bot",
      };
    });
    vi.spyOn(service as never, "acquireConnectorLock").mockImplementation(async () => {
      order.push("lock");
      return {release};
    });
    vi.spyOn(service as never, "ensureOutboundWorker").mockReturnValue({
      ...outboundWorker,
      start: vi.fn(async () => {
        order.push("outbound");
      }),
    });
    vi.spyOn(service as never, "ensureActionWorker").mockReturnValue({
      ...actionWorker,
      start: vi.fn(async () => {
        order.push("action");
      }),
    });

    const bot = latestBot();
    bot.api.setMyCommands.mockImplementationOnce(async () => {
      order.push("commands");
    });
    bot.api.getUpdates.mockImplementationOnce(async () => {
      order.push("poll");
      await service.stop();
      return [];
    });

    await expect(service.run()).resolves.toBeUndefined();

    expect(order).toEqual(["lock", "outbound", "action", "commands", "poll"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(stores.pool.end).toHaveBeenCalledTimes(1);
  });

  it("does not start workers when lock acquisition fails", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });
    vi.spyOn(service as never, "acquireConnectorLock").mockRejectedValue(new Error("Telegram connector 42 is already running."));
    const ensureOutboundWorker = vi.spyOn(service as never, "ensureOutboundWorker");
    const ensureActionWorker = vi.spyOn(service as never, "ensureActionWorker");

    await expect(service.run()).rejects.toThrow("Telegram connector 42 is already running.");

    expect(ensureOutboundWorker).not.toHaveBeenCalled();
    expect(ensureActionWorker).not.toHaveBeenCalled();
  });

  it("releases the connector lock when worker startup fails", async () => {
    const stores = createStores();
    const release = vi.fn(async () => {});
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockImplementation(async () => {
      (service as {stores?: unknown}).stores = stores;
      return {
        stores,
        connectorKey: "42",
        botUsername: "panda_bot",
      };
    });
    vi.spyOn(service as never, "acquireConnectorLock").mockResolvedValue({release});
    vi.spyOn(service as never, "ensureOutboundWorker").mockReturnValue({
      start: vi.fn(async () => {
        throw new Error("worker bootstrap failed");
      }),
      stop: vi.fn(async () => {}),
    });

    await expect(service.run()).rejects.toThrow("worker bootstrap failed");

    expect(release).toHaveBeenCalledTimes(1);
    expect(stores.pool.end).toHaveBeenCalledTimes(1);
  });

  it("enqueues telegram message requests with the normalized payload", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });
    vi.spyOn(service as never, "downloadSupportedMedia").mockResolvedValue([]);

    await (service as never).handleMessage(createTelegramContext());

    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith({
      kind: "telegram_message",
      payload: {
        connectorKey: "42",
        botUsername: "panda_bot",
        externalConversationId: "777",
        chatId: "777",
        chatType: "private",
        externalActorId: "123",
        externalMessageId: "555",
        text: "show me the bug",
        username: "alice",
        firstName: "Alice",
        lastName: "Liddell",
        replyToMessageId: undefined,
        media: [],
      },
    });
  });

  it("drops unsupported non-private messages before enqueuing runtime work", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });

    await (service as never).handleMessage({
      ...createTelegramContext(),
      chat: {
        id: -100123,
        type: "group",
      },
    });

    expect(stores.requests.enqueueRequest).not.toHaveBeenCalled();
  });

  it("enqueues reaction requests for added emoji", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });

    await (service as never).handleMessageReaction(createTelegramReactionContext());

    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith({
      kind: "telegram_reaction",
      payload: {
        connectorKey: "42",
        externalConversationId: "777",
        chatId: "777",
        chatType: "private",
        externalActorId: "123",
        updateId: 777001,
        targetMessageId: "555",
        addedEmojis: ["🔥"],
        username: "alice",
        firstName: "Alice",
        lastName: "Liddell",
      },
    });
  });

  it("ignores reaction removals, bot actors, and non-private chats", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });

    await (service as never).handleMessageReaction(createTelegramReactionContext({
      messageReaction: {
        chat: {
          id: 777,
          type: "private",
        },
        message_id: 555,
        user: {
          id: 123,
          username: "alice",
          is_bot: false,
        },
        old_reaction: [{type: "emoji", emoji: "🔥"}],
        new_reaction: [{type: "emoji", emoji: "🔥"}],
      },
    }));
    await (service as never).handleMessageReaction(createTelegramReactionContext({
      messageReaction: {
        chat: {
          id: 777,
          type: "private",
        },
        message_id: 555,
        user: {
          id: 123,
          username: "alice",
          is_bot: true,
        },
        old_reaction: [],
        new_reaction: [{type: "emoji", emoji: "🔥"}],
      },
    }));
    await (service as never).handleMessageReaction(createTelegramReactionContext({
      messageReaction: {
        chat: {
          id: -100123,
          type: "group",
        },
        message_id: 555,
        user: {
          id: 123,
          username: "alice",
          is_bot: false,
        },
        old_reaction: [],
        new_reaction: [{type: "emoji", emoji: "🔥"}],
      },
    }));

    expect(stores.requests.enqueueRequest).not.toHaveBeenCalled();
  });
});
