import {afterEach, describe, expect, it, vi} from "vitest";
import {createChatRuntime} from "../src/ui/tui/runtime.js";
import {resolveChatDisplayedCwd} from "../src/ui/tui/chat-session.js";

const tuiRuntimeSessionMocks = vi.hoisted(() => {
  const client = {
    identity: {
      id: "test-user",
      handle: "test-user",
      displayName: "Test User",
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
    createRuntimeClient: vi.fn(async () => client),
  };
});

vi.mock("../src/app/runtime/client.js", () => ({
  createRuntimeClient: tuiRuntimeSessionMocks.createRuntimeClient,
}));

describe("createChatRuntime session wiring", () => {
  afterEach(() => {
    tuiRuntimeSessionMocks.createRuntimeClient.mockClear();
    tuiRuntimeSessionMocks.client.createBranchSession.mockClear();
    tuiRuntimeSessionMocks.client.openMainSession.mockClear();
    tuiRuntimeSessionMocks.client.resetSession.mockClear();
    tuiRuntimeSessionMocks.client.close.mockClear();
    vi.unstubAllEnvs();
  });

  it("forwards the configured agent into main-session resolution", async () => {
    const runtime = await createChatRuntime({
      identity: "test-user",
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
      identity: "test-user",
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
      identity: "test-user",
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

  it("fails loudly when chat starts without an explicit identity", async () => {
    await expect(createChatRuntime({
      model: "openai-codex/gpt-5.4",
    })).rejects.toThrow("Panda chat requires --identity <handle>.");

    expect(tuiRuntimeSessionMocks.createRuntimeClient).not.toHaveBeenCalled();
  });

  it("shows the remote runner cwd for stored agent-home paths", () => {
    vi.stubEnv("BASH_EXECUTION_MODE", "remote");
    vi.stubEnv("RUNNER_CWD_TEMPLATE", "/root/.panda/agents/{agentKey}");
    vi.stubEnv("DATA_DIR", "/Users/tester/.panda");

    expect(resolveChatDisplayedCwd({
      id: "thread-1",
      sessionId: "session-1",
      context: {
        agentKey: "jozef",
        cwd: "/Users/tester/.panda/agents/jozef",
      },
      createdAt: 1,
      updatedAt: 1,
    } as any, "/Users/tester/Projects/panda-agent")).toBe("/root/.panda/agents/jozef");
  });
});
