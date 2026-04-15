import {afterEach, describe, expect, it, vi} from "vitest";
import {createChatRuntime} from "../src/ui/tui/runtime.js";

const tuiRuntimeSessionMocks = vi.hoisted(() => {
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
    createBranchSession: vi.fn(async () => ({
      id: "thread-created",
      sessionId: "session-created",
      context: {agentKey: "luna", sessionId: "session-created"},
      createdAt: 1,
      updatedAt: 1,
    })),
    openMainSession: vi.fn(async () => ({
      id: "thread-home",
      sessionId: "session-main",
      context: {agentKey: "luna", sessionId: "session-main"},
      createdAt: 1,
      updatedAt: 1,
    })),
    resetSession: vi.fn(async () => ({
      id: "thread-reset",
      sessionId: "session-main",
      context: {agentKey: "luna", sessionId: "session-main"},
      createdAt: 1,
      updatedAt: 1,
    })),
    openSession: vi.fn(async () => ({
      id: "thread-session",
      sessionId: "session-main",
      context: {agentKey: "luna", sessionId: "session-main"},
      createdAt: 1,
      updatedAt: 1,
    })),
    getThread: vi.fn(),
    listAgentSessions: vi.fn(async () => []),
    submitTextInput: vi.fn(),
    abortThread: vi.fn(async () => false),
    waitForCurrentRun: vi.fn(async () => {}),
    updateThread: vi.fn(),
    compactThread: vi.fn(),
    close: vi.fn(async () => {}),
  };

  return {
    client,
    createPandaClient: vi.fn(async () => client),
  };
});

vi.mock("../src/app/runtime/client.js", () => ({
  createPandaClient: tuiRuntimeSessionMocks.createPandaClient,
}));

describe("createChatRuntime session wiring", () => {
  afterEach(() => {
    tuiRuntimeSessionMocks.createPandaClient.mockClear();
    tuiRuntimeSessionMocks.client.createBranchSession.mockClear();
    tuiRuntimeSessionMocks.client.openMainSession.mockClear();
    tuiRuntimeSessionMocks.client.resetSession.mockClear();
    tuiRuntimeSessionMocks.client.close.mockClear();
  });

  it("forwards the configured agent into main-session resolution", async () => {
    const runtime = await createChatRuntime({
      identity: "local",
      agent: "luna",
      model: "openai-codex/gpt-5.4",
    });

    await runtime.openMainSession();

    expect(tuiRuntimeSessionMocks.client.openMainSession).toHaveBeenCalledWith({
      sessionId: undefined,
      agentKey: "luna",
      model: "openai-codex/gpt-5.4",
      thinking: undefined,
    });
  });

  it("leaves agentKey unset when chat did not explicitly choose an agent", async () => {
    const runtime = await createChatRuntime({
      identity: "local",
      model: "openai-codex/gpt-5.4",
    });

    await runtime.openMainSession();

    expect(tuiRuntimeSessionMocks.client.openMainSession).toHaveBeenCalledWith({
      sessionId: undefined,
      agentKey: undefined,
      model: "openai-codex/gpt-5.4",
      thinking: undefined,
    });
  });

  it("forwards agentKey when resetting the current session", async () => {
    const runtime = await createChatRuntime({
      identity: "local",
      agent: "jozef",
      model: "openai-codex/gpt-5.4",
    });

    await runtime.resetSession({
      agentKey: "luna",
      model: "openai-codex/gpt-5.4",
    });

    expect(tuiRuntimeSessionMocks.client.resetSession).toHaveBeenCalledWith({
      agentKey: "luna",
      model: "openai-codex/gpt-5.4",
      sessionId: undefined,
      thinking: undefined,
    });
  });
});
