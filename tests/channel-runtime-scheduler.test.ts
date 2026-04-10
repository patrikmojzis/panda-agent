import {afterEach, describe, expect, it, vi} from "vitest";

const channelRuntimeMocks = vi.hoisted(() => ({
  createPandaRuntime: vi.fn(),
  createConversationThreadStore: vi.fn(() => ({
    ensureSchema: vi.fn(async () => {}),
  })),
  createHomeThreadStore: vi.fn(() => ({
    ensureSchema: vi.fn(async () => {}),
    resolveHomeThread: vi.fn(async () => null),
    bindHomeThread: vi.fn(async () => ({
      binding: {
        identityId: "local",
        agentKey: "panda",
        threadId: "thread-home",
        createdAt: 1,
        updatedAt: 1,
      },
    })),
    resolveLastRoute: vi.fn(async () => null),
    rememberLastRoute: vi.fn(async () => ({
      identityId: "local",
      agentKey: "panda",
      threadId: "thread-home",
      createdAt: 1,
      updatedAt: 1,
    })),
  })),
  createChannelCursorStore: vi.fn(() => ({
    ensureSchema: vi.fn(async () => {}),
  })),
  createOutboundDeliveryStore: vi.fn(() => ({
    ensureSchema: vi.fn(async () => {}),
    enqueueDelivery: vi.fn(async () => ({
      id: "delivery-1",
    })),
  })),
  createMediaStore: vi.fn(() => ({
    rootDir: "/tmp/panda",
  })),
  createRunner: vi.fn(() => ({
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  })),
}));

vi.mock("../src/features/panda/runtime.js", async () => {
  const actual = await vi.importActual<typeof import("../src/features/panda/runtime.js")>("../src/features/panda/runtime.js");
  return {
    ...actual,
    createPandaRuntime: channelRuntimeMocks.createPandaRuntime,
  };
});

vi.mock("../src/features/conversation-threads/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/features/conversation-threads/index.js")>("../src/features/conversation-threads/index.js");
  return {
    ...actual,
    PostgresConversationThreadStore: vi.fn(function MockConversationThreadStore() {
      return channelRuntimeMocks.createConversationThreadStore();
    }),
  };
});

vi.mock("../src/features/home-threads/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/features/home-threads/index.js")>("../src/features/home-threads/index.js");
  return {
    ...actual,
    PostgresHomeThreadStore: vi.fn(function MockHomeThreadStore() {
      return channelRuntimeMocks.createHomeThreadStore();
    }),
  };
});

vi.mock("../src/features/channel-cursors/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/features/channel-cursors/index.js")>("../src/features/channel-cursors/index.js");
  return {
    ...actual,
    PostgresChannelCursorStore: vi.fn(function MockChannelCursorStore() {
      return channelRuntimeMocks.createChannelCursorStore();
    }),
  };
});

vi.mock("../src/features/outbound-deliveries/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/features/outbound-deliveries/index.js")>("../src/features/outbound-deliveries/index.js");
  return {
    ...actual,
    PostgresOutboundDeliveryStore: vi.fn(function MockOutboundDeliveryStore() {
      return channelRuntimeMocks.createOutboundDeliveryStore();
    }),
  };
});

vi.mock("../src/features/channels/core/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/features/channels/core/index.js")>("../src/features/channels/core/index.js");
  return {
    ...actual,
    FileSystemMediaStore: vi.fn(function MockMediaStore() {
      return channelRuntimeMocks.createMediaStore();
    }),
    ChannelTypingDispatcher: class {},
  };
});

vi.mock("../src/features/scheduled-tasks/index.js", async () => {
  const actual = await vi.importActual<typeof import("../src/features/scheduled-tasks/index.js")>("../src/features/scheduled-tasks/index.js");
  return {
    ...actual,
    ScheduledTaskRunner: vi.fn(function MockScheduledTaskRunner() {
      return channelRuntimeMocks.createRunner();
    }),
  };
});

function createPandaRuntimeMock() {
  return {
    close: vi.fn(async () => {}),
    coordinator: {},
    scheduledTasks: {},
    extraTools: [],
    agentStore: {
      getAgent: vi.fn(async () => ({
        agentKey: "panda",
      })),
    },
    identityStore: {
      ensureIdentity: vi.fn(async () => ({
        id: "local",
        handle: "local",
      })),
      getIdentity: vi.fn(async () => ({
        id: "local",
        handle: "local",
      })),
      getIdentityByHandle: vi.fn(async () => ({
        id: "local",
        handle: "local",
      })),
    },
    pool: {},
    store: {
      createThread: vi.fn(async () => ({
        id: "thread-home",
        identityId: "local",
        agentKey: "panda",
        context: {},
        createdAt: 1,
        updatedAt: 1,
      })),
      getThread: vi.fn(async () => ({
        id: "thread-home",
        identityId: "local",
        agentKey: "panda",
        context: {},
        createdAt: 1,
        updatedAt: 1,
      })),
    },
  };
}

describe("channel runtime scheduler wiring", () => {
  afterEach(() => {
    channelRuntimeMocks.createPandaRuntime.mockReset();
    channelRuntimeMocks.createConversationThreadStore.mockClear();
    channelRuntimeMocks.createHomeThreadStore.mockClear();
    channelRuntimeMocks.createChannelCursorStore.mockClear();
    channelRuntimeMocks.createOutboundDeliveryStore.mockClear();
    channelRuntimeMocks.createMediaStore.mockClear();
    channelRuntimeMocks.createRunner.mockClear();
  });

  it("starts and stops the Telegram scheduled-task runner when a connector key is available", async () => {
    channelRuntimeMocks.createPandaRuntime.mockResolvedValue(createPandaRuntimeMock());
    const {createTelegramRuntime} = await import("../src/features/telegram/runtime.js");

    const runtime = await createTelegramRuntime({
      cwd: "/workspace/panda",
      locale: "en-US",
      timezone: "UTC",
      dataDir: "/tmp/panda",
      telegramConnectorKey: "bot-1",
    });

    expect(channelRuntimeMocks.createRunner).toHaveBeenCalledTimes(1);
    const runner = channelRuntimeMocks.createRunner.mock.results[0]?.value;
    expect(runner?.start).toHaveBeenCalledTimes(1);

    await runtime.close();
    expect(runner?.stop).toHaveBeenCalledTimes(1);
  });

  it("starts and stops the WhatsApp scheduled-task runner when a connector key is available", async () => {
    channelRuntimeMocks.createPandaRuntime.mockResolvedValue(createPandaRuntimeMock());
    const {createWhatsAppRuntime} = await import("../src/features/whatsapp/runtime.js");

    const runtime = await createWhatsAppRuntime({
      cwd: "/workspace/panda",
      dataDir: "/tmp/panda",
      connectorKey: "wa-1",
    });

    expect(channelRuntimeMocks.createRunner).toHaveBeenCalledTimes(1);
    const runner = channelRuntimeMocks.createRunner.mock.results[0]?.value;
    expect(runner?.start).toHaveBeenCalledTimes(1);

    await runtime.close();
    expect(runner?.stop).toHaveBeenCalledTimes(1);
  });

  it("does not start a scheduled-task runner in the TUI runtime", async () => {
    channelRuntimeMocks.createPandaRuntime.mockResolvedValue(createPandaRuntimeMock());
    const {createChatRuntime} = await import("../src/features/tui/runtime.js");

    const runtime = await createChatRuntime({
      cwd: "/workspace/panda",
      locale: "en-US",
      timezone: "UTC",
    });

    expect(channelRuntimeMocks.createRunner).toHaveBeenCalledTimes(0);
    await runtime.close();
  });
});
