import {describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";

import {
  Agent,
  type LlmRuntime,
  stringToUserMessage,
} from "../src/index.js";
import {
  type ResolvedThreadDefinition,
  ThreadRuntimeCoordinator,
} from "../src/domain/threads/runtime/index.js";
import type {
  CreateSessionInput,
  ListAgentSessionsInput,
  SessionHeartbeatRecord,
  SessionRecord,
  UpdateSessionCurrentThreadInput,
} from "../src/domain/sessions/index.js";
import type {SessionStore} from "../src/domain/sessions/store.js";
import type {
  ClaimSessionHeartbeatInput,
  ListDueSessionHeartbeatsInput,
  RecordSessionHeartbeatResultInput,
  UpdateSessionHeartbeatConfigInput,
} from "../src/domain/sessions/types.js";
import {
  INTUITION_OBSERVATION_SOURCE,
  INTUITION_SIDECAR_SOURCE,
  IntuitionSidecarService,
} from "../src/app/runtime/intuition-sidecar.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

function message(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    model: "openai/gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function createMockRuntime(...responses: AssistantMessage[]): LlmRuntime & {
  complete: ReturnType<typeof vi.fn>;
} {
  return {
    complete: vi.fn().mockImplementation(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("No more mock responses queued");
      }

      return response;
    }),
    stream: vi.fn(() => {
      throw new Error("Streaming was not expected in this test");
    }),
  };
}

class SelectiveLeaseManager {
  async tryAcquire(threadId: string) {
    return {
      threadId,
      release: async () => {},
    };
  }
}

class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async ensureSchema(): Promise<void> {}

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = Date.now();
    const session: SessionRecord = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    return {...session};
  }

  async getSession(sessionId: string): Promise<SessionRecord> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown session ${sessionId}`);
    }
    return {...session};
  }

  async getMainSession(agentKey: string): Promise<SessionRecord | null> {
    return [...this.sessions.values()].find((session) => {
      return session.agentKey === agentKey && session.kind === "main";
    }) ?? null;
  }

  async listAgentSessions(input: string | ListAgentSessionsInput): Promise<readonly SessionRecord[]> {
    const agentKey = typeof input === "string" ? input : input.agentKey;
    return [...this.sessions.values()]
      .filter((session) => session.agentKey === agentKey)
      .map((session) => ({...session}));
  }

  async updateCurrentThread(input: UpdateSessionCurrentThreadInput): Promise<SessionRecord> {
    const session = await this.getSession(input.sessionId);
    const updated = {
      ...session,
      currentThreadId: input.currentThreadId,
      updatedAt: Date.now(),
    };
    this.sessions.set(updated.id, updated);
    return {...updated};
  }

  async getHeartbeat(): Promise<SessionHeartbeatRecord | null> {
    return null;
  }

  async listDueHeartbeats(_input?: ListDueSessionHeartbeatsInput): Promise<readonly SessionHeartbeatRecord[]> {
    return [];
  }

  async claimHeartbeat(_input: ClaimSessionHeartbeatInput): Promise<SessionHeartbeatRecord | null> {
    return null;
  }

  async recordHeartbeatResult(_input: RecordSessionHeartbeatResultInput): Promise<SessionHeartbeatRecord> {
    throw new Error("Heartbeat storage is not used in this test.");
  }

  async updateHeartbeatConfig(_input: UpdateSessionHeartbeatConfigInput): Promise<SessionHeartbeatRecord> {
    throw new Error("Heartbeat storage is not used in this test.");
  }
}

async function createMainSession(options: {
  sessionStore: MemorySessionStore;
  threadStore: TestThreadRuntimeStore;
  agentKey?: string;
}): Promise<void> {
  const agentKey = options.agentKey ?? "panda";
  await options.sessionStore.createSession({
    id: "session-main",
    agentKey,
    kind: "main",
    currentThreadId: "thread-main",
  });
  await options.threadStore.createThread({
    id: "thread-main",
    sessionId: "session-main",
    context: {
      sessionId: "session-main",
      threadId: "thread-main",
      agentKey,
      cwd: "/workspace/panda",
    },
  });
}

function definition(runtime?: LlmRuntime): ResolvedThreadDefinition {
  return {
    agent: new Agent({
      name: "panda",
      instructions: "Reply plainly.",
    }),
    runtime,
  };
}

describe("Intuition sidecar", () => {
  it("creates a visible sidecar session and observation thread input", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    const submitted: Array<{threadId: string; source: string}> = [];
    await createMainSession({sessionStore, threadStore});
    await threadStore.enqueueInput("thread-main", {
      message: stringToUserMessage("VAT XML"),
      source: "tui",
    });
    const appliedInputs = await threadStore.applyPendingInputs("thread-main");
    const run = await threadStore.createRun("thread-main");
    const mainThread = await threadStore.getThread("thread-main");

    const service = new IntuitionSidecarService({
      sessionStore,
      threadStore,
      runtime: {
        submitInput: async (threadId, payload) => {
          submitted.push({threadId, source: payload.source});
          await threadStore.enqueueInput(threadId, payload);
        },
      },
      softWaitMs: 1,
    });

    await service.beforeRunStep({
      run,
      thread: mainThread,
      definition: definition(),
      appliedInputs,
      transcript: await threadStore.loadTranscript("thread-main"),
      signal: new AbortController().signal,
    });

    const sessions = await sessionStore.listAgentSessions("panda");
    const sidecar = sessions.find((session) => session.kind === "sidecar");
    expect(sidecar).toBeDefined();
    expect(sessions.map((session) => session.kind)).toContain("sidecar");
    expect(submitted).toEqual([{
      threadId: sidecar?.currentThreadId,
      source: INTUITION_OBSERVATION_SOURCE,
    }]);
  });

  it("does not observe sidecar threads recursively", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    const submitted = vi.fn();
    await sessionStore.createSession({
      id: "sidecar-session",
      agentKey: "panda",
      kind: "sidecar",
      currentThreadId: "sidecar-thread",
      metadata: {
        intuitionSidecar: {
          kind: "intuition_sidecar",
          parentSessionId: "session-main",
        },
      },
    });
    await threadStore.createThread({
      id: "sidecar-thread",
      sessionId: "sidecar-session",
      context: {
        sessionId: "sidecar-session",
        agentKey: "panda",
        intuitionSidecar: {
          kind: "intuition_sidecar",
          parentSessionId: "session-main",
        },
      },
    });
    await threadStore.enqueueInput("sidecar-thread", {
      message: stringToUserMessage("observe"),
      source: INTUITION_OBSERVATION_SOURCE,
    });
    const appliedInputs = await threadStore.applyPendingInputs("sidecar-thread");
    const run = await threadStore.createRun("sidecar-thread");
    const sidecarThread = await threadStore.getThread("sidecar-thread");
    const service = new IntuitionSidecarService({
      sessionStore,
      threadStore,
      runtime: {submitInput: submitted},
      softWaitMs: 1,
    });

    await service.beforeRunStep({
      run,
      thread: sidecarThread,
      definition: definition(),
      appliedInputs,
      transcript: await threadStore.loadTranscript("sidecar-thread"),
      signal: new AbortController().signal,
    });

    expect(submitted).not.toHaveBeenCalled();
  });

  it("injects a fast sidecar whisper into the main run before the LLM call", async () => {
    const threadStore = new TestThreadRuntimeStore();
    await threadStore.createThread({
      id: "thread-main",
      sessionId: "session-main",
      context: {
        sessionId: "session-main",
        agentKey: "panda",
      },
    });
    const runtime = createMockRuntime(message("handled"));
    const coordinator = new ThreadRuntimeCoordinator({
      store: threadStore,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: () => definition(runtime),
      beforeRunStep: async (input) => {
        await threadStore.enqueueInput(input.thread.id, {
          message: stringToUserMessage("[Internal intuition note]\nLoad the VAT XML skill."),
          source: INTUITION_SIDECAR_SOURCE,
        });
      },
    });

    await coordinator.submitInput("thread-main", {
      message: stringToUserMessage("VAT XML"),
      source: "heartbeat",
    });
    await coordinator.waitForIdle("thread-main");

    expect(runtime.complete).toHaveBeenCalledTimes(1);
    const request = runtime.complete.mock.calls[0]?.[0];
    expect(String(request.context.messages.at(-1)?.content ?? "")).toContain("[Internal intuition note]");
    expect(String(request.context.messages.at(-1)?.content ?? "")).toContain("VAT XML skill");
    const transcript = await threadStore.loadTranscript("thread-main");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "heartbeat",
      INTUITION_SIDECAR_SOURCE,
      "assistant",
    ]);
  });

  it("continues the main run when the sidecar hook fails", async () => {
    const threadStore = new TestThreadRuntimeStore();
    await threadStore.createThread({
      id: "thread-main",
      sessionId: "session-main",
      context: {
        sessionId: "session-main",
        agentKey: "panda",
      },
    });
    const runtime = createMockRuntime(message("handled without intuition"));
    const coordinator = new ThreadRuntimeCoordinator({
      store: threadStore,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: () => definition(runtime),
      beforeRunStep: async () => {
        throw new Error("sidecar unavailable");
      },
    });

    await coordinator.submitInput("thread-main", {
      message: stringToUserMessage("VAT XML"),
      source: "heartbeat",
    });
    await coordinator.waitForIdle("thread-main");

    expect(runtime.complete).toHaveBeenCalledTimes(1);
    const runs = await threadStore.listRuns("thread-main");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    const transcript = await threadStore.loadTranscript("thread-main");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "heartbeat",
      "assistant",
    ]);
  });

  it("wakes Panda when a late whisper is emitted after the main run", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    await createMainSession({sessionStore, threadStore});
    const runtime = createMockRuntime(message("noticed intuition"));
    const coordinator = new ThreadRuntimeCoordinator({
      store: threadStore,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: () => definition(runtime),
    });
    const service = new IntuitionSidecarService({
      sessionStore,
      threadStore,
      runtime: {
        submitInput: (threadId, payload, mode) => coordinator.submitInput(threadId, payload, mode),
      },
      softWaitMs: 1,
    });

    await service.emitWhisper({
      parentThreadId: "thread-main",
      parentRunId: "run-late",
      sidecarThreadId: "sidecar-thread",
      message: "Check the apartment wiki before giving drawdown dates.",
    });
    await coordinator.waitForIdle("thread-main");

    const transcript = await threadStore.loadTranscript("thread-main");
    expect(transcript.map((entry) => entry.source)).toEqual([
      INTUITION_SIDECAR_SOURCE,
      "assistant",
    ]);
    expect(runtime.complete).toHaveBeenCalledTimes(1);
  });

  it("does not create a sidecar observation for intuition-only input", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    const submitted = vi.fn();
    await createMainSession({sessionStore, threadStore});
    await threadStore.enqueueInput("thread-main", {
      message: stringToUserMessage("[Internal intuition note]\nCheck tax memory."),
      source: INTUITION_SIDECAR_SOURCE,
    });
    const appliedInputs = await threadStore.applyPendingInputs("thread-main");
    const run = await threadStore.createRun("thread-main");
    const service = new IntuitionSidecarService({
      sessionStore,
      threadStore,
      runtime: {submitInput: submitted},
      softWaitMs: 1,
    });

    await service.beforeRunStep({
      run,
      thread: await threadStore.getThread("thread-main"),
      definition: definition(),
      appliedInputs,
      transcript: await threadStore.loadTranscript("thread-main"),
      signal: new AbortController().signal,
    });

    expect(submitted).not.toHaveBeenCalled();
  });

  it("uses the dedicated sidecar model and approved tool set", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    await sessionStore.createSession({
      id: "sidecar-session",
      agentKey: "panda",
      kind: "sidecar",
      currentThreadId: "sidecar-thread",
      metadata: {
        intuitionSidecar: {
          kind: "intuition_sidecar",
          parentSessionId: "session-main",
        },
      },
    });
    await threadStore.createThread({
      id: "sidecar-thread",
      sessionId: "sidecar-session",
      context: {
        sessionId: "sidecar-session",
        agentKey: "panda",
        intuitionSidecar: {
          kind: "intuition_sidecar",
          parentSessionId: "session-main",
        },
      },
    });
    const service = new IntuitionSidecarService({
      sessionStore,
      threadStore,
      runtime: {submitInput: vi.fn()},
      pool: {
        query: vi.fn(),
        connect: vi.fn(),
      },
      wikiBindings: {
        getBinding: vi.fn(),
      },
      env: {
        ...process.env,
        INTUITION_SIDECAR_MODEL: "gpt",
        BRAVE_API_KEY: "test-key",
      },
    });

    const resolved = await service.resolveDefinition(
      await threadStore.getThread("sidecar-thread"),
      await sessionStore.getSession("sidecar-session"),
    );

    expect(resolved.model).toBe("openai-codex/gpt-5.4");
    expect(resolved.promptCacheKey).toBe("sidecar:session-main");
    expect(resolved.promptCacheKey?.length).toBeLessThanOrEqual(64);
    expect(resolved.agent.tools.map((tool) => tool.name).sort()).toEqual([
      "brave_search",
      "current_datetime",
      "postgres_readonly_query",
      "web_fetch",
      "whisper_to_main",
      "wiki",
    ]);
  });
});
