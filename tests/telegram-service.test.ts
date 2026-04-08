import { afterEach, describe, expect, it, vi } from "vitest";

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
    };
    readonly on = vi.fn((event: string, handler: (ctx: unknown) => Promise<void> | void) => {
      this.handlers.set(event, handler);
      return this;
    });
    readonly handleUpdate = vi.fn(async (update: { context?: unknown }) => {
      const handler = this.handlers.get("message");
      if (!handler) {
        return;
      }

      await handler(update.context);
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
    createTelegramRuntime: vi.fn(),
  };
});

vi.mock("grammy", () => ({
  Bot: telegramServiceMocks.MockBot,
}));

vi.mock("../src/features/telegram/runtime.js", () => ({
  createTelegramRuntime: telegramServiceMocks.createTelegramRuntime,
}));

import { TELEGRAM_SOURCE, TELEGRAM_UPDATES_CURSOR_KEY } from "../src/features/telegram/config.js";
import { TelegramService } from "../src/features/telegram/service.js";

interface RuntimeMock {
  channelCursors: {
    resolveChannelCursor: ReturnType<typeof vi.fn>;
    upsertChannelCursor: ReturnType<typeof vi.fn>;
  };
  close: ReturnType<typeof vi.fn>;
  conversationThreads: {
    bindConversationThread: ReturnType<typeof vi.fn>;
    resolveConversationThread: ReturnType<typeof vi.fn>;
  };
  coordinator: {
    abort: ReturnType<typeof vi.fn>;
    submitInput: ReturnType<typeof vi.fn>;
    waitForCurrentRun: ReturnType<typeof vi.fn>;
  };
  createThread: ReturnType<typeof vi.fn>;
  getThread: ReturnType<typeof vi.fn>;
  identityStore: {
    ensureIdentity: ReturnType<typeof vi.fn>;
    ensureIdentityBinding: ReturnType<typeof vi.fn>;
    getIdentityByHandle: ReturnType<typeof vi.fn>;
    resolveIdentityBinding: ReturnType<typeof vi.fn>;
  };
}

function createRuntimeMock(): RuntimeMock {
  return {
    channelCursors: {
      resolveChannelCursor: vi.fn(async () => null),
      upsertChannelCursor: vi.fn(async () => ({
        source: TELEGRAM_SOURCE,
        connectorKey: "42",
        cursorKey: TELEGRAM_UPDATES_CURSOR_KEY,
        value: "0",
      })),
    },
    close: vi.fn(async () => {}),
    conversationThreads: {
      bindConversationThread: vi.fn(async () => ({
        binding: {},
      })),
      resolveConversationThread: vi.fn(async () => null),
    },
    coordinator: {
      abort: vi.fn(async () => false),
      submitInput: vi.fn(async () => {}),
      waitForCurrentRun: vi.fn(async () => {}),
    },
    createThread: vi.fn(async () => ({
      id: "thread-1",
      identityId: "identity-1",
      agentKey: "panda",
      createdAt: 1,
      updatedAt: 1,
    })),
    getThread: vi.fn(async () => ({
      id: "thread-1",
      identityId: "identity-1",
      agentKey: "panda",
      createdAt: 1,
      updatedAt: 1,
    })),
    identityStore: {
      ensureIdentity: vi.fn(async () => ({
        id: "identity-1",
      })),
      ensureIdentityBinding: vi.fn(async () => ({
        id: "binding-1",
      })),
      getIdentityByHandle: vi.fn(async () => ({
        id: "identity-1",
      })),
      resolveIdentityBinding: vi.fn(async () => ({
        id: "binding-1",
        identityId: "identity-1",
        source: TELEGRAM_SOURCE,
        connectorKey: "42",
        externalActorId: "123",
        createdAt: 1,
        updatedAt: 1,
      })),
    },
  };
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
    reply: vi.fn(async () => {}),
  };
}

function latestBot(): InstanceType<typeof telegramServiceMocks.MockBot> {
  const bot = telegramServiceMocks.botInstances.at(-1);
  if (!bot) {
    throw new Error("Expected a mocked Telegram bot instance.");
  }

  return bot;
}

describe("TelegramService", () => {
  afterEach(() => {
    telegramServiceMocks.botInstances.length = 0;
    telegramServiceMocks.createTelegramRuntime.mockReset();
    vi.restoreAllMocks();
  });

  it("retries a failed update instead of crashing the worker", async () => {
    const runtime = createRuntimeMock();
    telegramServiceMocks.createTelegramRuntime.mockResolvedValue(runtime);

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
      cwd: "/Users/patrikmojzis/Projects/panda",
      locale: "en-US",
      timezone: "UTC",
    });
    vi.spyOn(service as never, "acquireConnectorLock").mockResolvedValue({
      release: vi.fn(async () => {}),
    });
    vi.spyOn(service as never, "handleMessage")
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const update = {
      update_id: 101,
      context: createTelegramContext(),
    };
    const bot = latestBot();
    bot.api.getUpdates
      .mockResolvedValueOnce([update])
      .mockResolvedValueOnce([update]);
    runtime.channelCursors.upsertChannelCursor.mockImplementationOnce(async () => {
      await service.stop();
      return {
        source: TELEGRAM_SOURCE,
        connectorKey: "42",
        cursorKey: TELEGRAM_UPDATES_CURSOR_KEY,
        value: "101",
      };
    });

    await expect(service.run()).resolves.toBeUndefined();

    expect(bot.api.getUpdates).toHaveBeenCalledTimes(2);
    expect(runtime.channelCursors.upsertChannelCursor).toHaveBeenCalledTimes(1);
    expect(runtime.channelCursors.upsertChannelCursor).toHaveBeenCalledWith({
      source: TELEGRAM_SOURCE,
      connectorKey: "42",
      cursorKey: TELEGRAM_UPDATES_CURSOR_KEY,
      value: "101",
    });
    write.mockRestore();
  });

  it("does not advance the cursor when media download fails and retries the update", async () => {
    const runtime = createRuntimeMock();
    runtime.conversationThreads.resolveConversationThread.mockResolvedValue({
      source: TELEGRAM_SOURCE,
      connectorKey: "42",
      externalConversationId: "777",
      threadId: "thread-1",
      createdAt: 1,
      updatedAt: 1,
    });
    telegramServiceMocks.createTelegramRuntime.mockResolvedValue(runtime);

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
      cwd: "/Users/patrikmojzis/Projects/panda",
      locale: "en-US",
      timezone: "UTC",
    });
    vi.spyOn(service as never, "acquireConnectorLock").mockResolvedValue({
      release: vi.fn(async () => {}),
    });
    vi.spyOn(service as never, "downloadSupportedMedia")
      .mockRejectedValueOnce(new Error("download blew up"))
      .mockResolvedValueOnce([]);

    const update = {
      update_id: 202,
      context: createTelegramContext(),
    };
    const bot = latestBot();
    bot.api.getUpdates
      .mockResolvedValueOnce([update])
      .mockResolvedValueOnce([update]);
    runtime.channelCursors.upsertChannelCursor.mockImplementationOnce(async () => {
      await service.stop();
      return {
        source: TELEGRAM_SOURCE,
        connectorKey: "42",
        cursorKey: TELEGRAM_UPDATES_CURSOR_KEY,
        value: "202",
      };
    });

    await expect(service.run()).resolves.toBeUndefined();

    expect(runtime.coordinator.submitInput).toHaveBeenCalledTimes(1);
    expect(runtime.channelCursors.upsertChannelCursor).toHaveBeenCalledTimes(1);
    expect(runtime.channelCursors.upsertChannelCursor).toHaveBeenCalledWith({
      source: TELEGRAM_SOURCE,
      connectorKey: "42",
      cursorKey: TELEGRAM_UPDATES_CURSOR_KEY,
      value: "202",
    });
    write.mockRestore();
  });
});
