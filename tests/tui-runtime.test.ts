import { afterEach, describe, expect, it, vi } from "vitest";

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

import { createChatRuntime } from "../src/features/tui/runtime.js";

describe("createChatRuntime", () => {
  afterEach(() => {
    tuiRuntimeMocks.createPandaRuntime.mockReset();
    tuiRuntimeMocks.createHomeThreadStore.mockClear();
    tuiRuntimeMocks.resolveStoredPandaContext.mockClear();
  });

  it("closes the shared Panda runtime when identity lookup fails", async () => {
    const close = vi.fn(async () => {});

    tuiRuntimeMocks.createPandaRuntime.mockResolvedValue({
      close,
      coordinator: {},
      extraTools: [],
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
});
