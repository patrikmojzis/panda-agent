import {afterEach, describe, expect, it, vi} from "vitest";
import {createChatRuntime} from "../src/features/tui/runtime.js";

const tuiRuntimeMocks = vi.hoisted(() => ({
  createPandaRuntime: vi.fn(),
  createHomeThreadStore: vi.fn(() => ({
    ensureSchema: vi.fn(async () => {}),
    resolveHomeThread: vi.fn(async () => null),
    bindHomeThread: vi.fn(async () => ({
      binding: {
        identityId: "local",
        agentKey: "panda",
        threadId: "thread-created",
        createdAt: 1,
        updatedAt: 1,
      },
    })),
  })),
  createOutboundDeliveryStore: vi.fn(() => ({
    ensureSchema: vi.fn(async () => {}),
    enqueueDelivery: vi.fn(async () => ({
      id: "delivery-1",
    })),
  })),
  resolveStoredPandaContext: vi.fn((_value: unknown, fallback: Record<string, unknown>) => ({ ...fallback })),
}));

vi.mock("../src/features/panda/runtime.js", () => ({
  createPandaRuntime: tuiRuntimeMocks.createPandaRuntime,
  resolveStoredPandaContext: tuiRuntimeMocks.resolveStoredPandaContext,
}));

vi.mock("../src/features/home-threads/index.js", () => ({
  PostgresHomeThreadStore: vi.fn(function MockHomeThreadStore() {
    return tuiRuntimeMocks.createHomeThreadStore();
  }),
}));

vi.mock("../src/features/outbound-deliveries/index.js", () => ({
  PostgresOutboundDeliveryStore: vi.fn(function MockOutboundDeliveryStore() {
    return tuiRuntimeMocks.createOutboundDeliveryStore();
  }),
}));

describe("createChatRuntime", () => {
  afterEach(() => {
    tuiRuntimeMocks.createPandaRuntime.mockReset();
    tuiRuntimeMocks.createHomeThreadStore.mockClear();
    tuiRuntimeMocks.createOutboundDeliveryStore.mockClear();
    tuiRuntimeMocks.resolveStoredPandaContext.mockClear();
  });

  it("closes the shared Panda runtime when identity lookup fails", async () => {
    const close = vi.fn(async () => {});

    tuiRuntimeMocks.createPandaRuntime.mockResolvedValue({
      close,
      coordinator: {},
      extraTools: [],
      agentStore: {
        getAgent: vi.fn(async () => ({
          agentKey: "panda",
        })),
      },
      identityStore: {
        ensureIdentity: vi.fn(),
        getIdentityByHandle: vi.fn(async () => {
          throw new Error("Identity alice not found.");
        }),
      },
      store: {},
    });

    await expect(createChatRuntime({
      cwd: "/workspace/panda",
      locale: "en-US",
      timezone: "UTC",
      identity: "alice",
    })).rejects.toThrow("Identity alice not found.");

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("creates a fresh home instead of adopting the most recent thread when none is bound", async () => {
    const createThread = vi.fn(async () => ({
      id: "thread-created",
      identityId: "local",
      agentKey: "panda",
      context: {},
      createdAt: 1,
      updatedAt: 1,
    }));
    const listThreadSummaries = vi.fn(async () => [{
      thread: {
        id: "thread-branch",
        identityId: "local",
        agentKey: "panda",
        context: {},
        createdAt: 1,
        updatedAt: 2,
      },
      latestMessage: null,
      messageCount: 0,
      pendingInputCount: 0,
    }]);

    tuiRuntimeMocks.createPandaRuntime.mockResolvedValue({
      close: vi.fn(async () => {}),
      coordinator: {},
      extraTools: [],
      agentStore: {
        getAgent: vi.fn(async () => ({
          agentKey: "panda",
        })),
      },
      pool: {},
      identityStore: {
        ensureIdentity: vi.fn(async () => ({
          id: "local",
          handle: "local",
        })),
        getIdentityByHandle: vi.fn(),
      },
      store: {
        createThread,
        getThread: vi.fn(),
        listThreadSummaries,
      },
    });

    const runtime = await createChatRuntime({
      cwd: "/workspace/panda",
      locale: "en-US",
      timezone: "UTC",
    });

    const thread = await runtime.resolveOrCreateHomeThread();

    expect(thread.id).toBe("thread-created");
    expect(createThread).toHaveBeenCalledTimes(1);
    expect(listThreadSummaries).not.toHaveBeenCalled();
  });

  it("uses the configured default agent for new home threads", async () => {
    const createThread = vi.fn(async (input: { agentKey?: string }) => ({
      id: "thread-created",
      identityId: "local",
      agentKey: input.agentKey ?? "panda",
      context: {},
      createdAt: 1,
      updatedAt: 1,
    }));
    const getAgent = vi.fn(async (agentKey: string) => ({
      agentKey,
    }));

    tuiRuntimeMocks.createPandaRuntime.mockResolvedValue({
      close: vi.fn(async () => {}),
      coordinator: {},
      extraTools: [],
      agentStore: {
        getAgent,
      },
      pool: {},
      identityStore: {
        ensureIdentity: vi.fn(async () => ({
          id: "local",
          handle: "local",
        })),
        getIdentityByHandle: vi.fn(),
      },
      store: {
        createThread,
        getThread: vi.fn(),
        listThreadSummaries: vi.fn(async () => []),
      },
    });

    const runtime = await createChatRuntime({
      cwd: "/workspace/panda",
      locale: "en-US",
      timezone: "UTC",
      agent: "ops",
    });

    const thread = await runtime.resolveOrCreateHomeThread();

    expect(getAgent).toHaveBeenCalledWith("ops");
    expect(thread.agentKey).toBe("ops");
    expect(createThread).toHaveBeenCalledWith(expect.objectContaining({
      agentKey: "ops",
    }));
  });

  it("rejects rebinding a thread under a different home agent", async () => {
    tuiRuntimeMocks.createPandaRuntime.mockResolvedValue({
      close: vi.fn(async () => {}),
      coordinator: {},
      extraTools: [],
      agentStore: {
        getAgent: vi.fn(async () => ({
          agentKey: "panda",
        })),
      },
      pool: {},
      identityStore: {
        ensureIdentity: vi.fn(async () => ({
          id: "local",
          handle: "local",
        })),
        getIdentityByHandle: vi.fn(),
      },
      store: {
        createThread: vi.fn(),
        getThread: vi.fn(async () => ({
          id: "thread-created",
          identityId: "local",
          agentKey: "panda",
          context: {},
          createdAt: 1,
          updatedAt: 1,
        })),
        listThreadSummaries: vi.fn(async () => []),
      },
    });

    const runtime = await createChatRuntime({
      cwd: "/workspace/panda",
      locale: "en-US",
      timezone: "UTC",
    });

    const homeThreads = tuiRuntimeMocks.createHomeThreadStore.mock.results.at(-1)?.value;
    const bindHomeThread = homeThreads?.bindHomeThread;

    await expect(runtime.setHomeThread("thread-created", "ops")).rejects.toThrow(
      "Cannot bind thread thread-created with agent panda under home agent ops.",
    );
    expect(bindHomeThread).not.toHaveBeenCalled();
  });
});
