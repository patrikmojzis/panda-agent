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
      getFile: vi.fn(async () => ({
        file_path: "documents/file.zip",
      })),
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

describe("TelegramService", () => {
  afterEach(() => {
    vi.useRealTimers();
    telegramServiceMocks.botInstances.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reports the bot identity through the public connector interface", async () => {
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    await expect(service.whoami()).resolves.toEqual({
      connectorKey: "42",
      id: "42",
      username: "panda_bot",
    });
  });

  it("fails closed when expected connector key does not match the bot token identity", async () => {
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
      expectedConnectorKey: "99",
    });

    await expect(service.whoami()).rejects.toThrow("Telegram bot token identity does not match the connector account.");
  });

});
