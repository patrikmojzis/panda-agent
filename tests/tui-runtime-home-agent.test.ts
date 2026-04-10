import {afterEach, describe, expect, it, vi} from "vitest";
import {createChatRuntime} from "../src/features/tui/runtime.js";

const tuiRuntimeHomeAgentMocks = vi.hoisted(() => {
  const client = {
    identity: {
      id: "local",
      handle: "local",
      displayName: "Local",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    },
    store: {},
    createThread: vi.fn(async () => ({
      id: "thread-created",
      identityId: "local",
      agentKey: "luna",
      context: {},
      createdAt: 1,
      updatedAt: 1,
    })),
    resolveOrCreateHomeThread: vi.fn(async () => ({
      id: "thread-home",
      identityId: "local",
      agentKey: "luna",
      context: {},
      createdAt: 1,
      updatedAt: 1,
    })),
    resetHomeThread: vi.fn(async () => ({
      id: "thread-reset",
      identityId: "local",
      agentKey: "luna",
      context: {},
      createdAt: 1,
      updatedAt: 1,
    })),
    getThread: vi.fn(),
    listThreadSummaries: vi.fn(async () => []),
    submitTextInput: vi.fn(),
    abortThread: vi.fn(async () => false),
    waitForCurrentRun: vi.fn(async () => {}),
    updateThread: vi.fn(),
    compactThread: vi.fn(),
    switchHomeAgent: vi.fn(),
    close: vi.fn(async () => {}),
  };

  return {
    client,
    createPandaClient: vi.fn(async () => client),
  };
});

vi.mock("../src/features/panda/client.js", () => ({
  createPandaClient: tuiRuntimeHomeAgentMocks.createPandaClient,
}));

describe("createChatRuntime home-agent wiring", () => {
  afterEach(() => {
    tuiRuntimeHomeAgentMocks.createPandaClient.mockClear();
    tuiRuntimeHomeAgentMocks.client.createThread.mockClear();
    tuiRuntimeHomeAgentMocks.client.resolveOrCreateHomeThread.mockClear();
    tuiRuntimeHomeAgentMocks.client.resetHomeThread.mockClear();
    tuiRuntimeHomeAgentMocks.client.close.mockClear();
  });

  it("forwards the configured agent into home resolution", async () => {
    const runtime = await createChatRuntime({
      identity: "local",
      agent: "luna",
      provider: "openai-codex",
      model: "gpt-5.4",
    });

    await runtime.resolveOrCreateHomeThread();

    expect(tuiRuntimeHomeAgentMocks.client.resolveOrCreateHomeThread).toHaveBeenCalledWith({
      id: undefined,
      agentKey: "luna",
      provider: "openai-codex",
      model: "gpt-5.4",
      thinking: undefined,
    });
  });

  it("forwards agentKey when resetting the home thread", async () => {
    const runtime = await createChatRuntime({
      identity: "local",
      agent: "jozef",
      provider: "openai-codex",
      model: "gpt-5.4",
    });

    await runtime.resetHomeThread({
      agentKey: "luna",
      provider: "openai-codex",
      model: "gpt-5.4",
    });

    expect(tuiRuntimeHomeAgentMocks.client.resetHomeThread).toHaveBeenCalledWith({
      agentKey: "luna",
      provider: "openai-codex",
      model: "gpt-5.4",
      thinking: undefined,
    });
  });
});
