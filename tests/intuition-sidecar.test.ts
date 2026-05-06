import {describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";

import {Agent, type LlmRuntime, stringToUserMessage, Tool, z,} from "../src/index.js";
import {type ResolvedThreadDefinition, ThreadRuntimeCoordinator,} from "../src/domain/threads/runtime/index.js";
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

function createAssistantMessage(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
  return {
    role: "assistant",
    content,
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
    stopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}

function message(text: string): AssistantMessage {
  return createAssistantMessage([{ type: "text", text }]);
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

class EchoTool extends Tool<typeof EchoTool.schema> {
  name = "echo";
  description = "Echo a message";
  static schema = z.object({
    message: z.string(),
  });
  schema = EchoTool.schema;

  async handle(args: z.output<typeof EchoTool.schema>): Promise<{ echoed: string }> {
    return {
      echoed: args.message,
    };
  }
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
  it("creates a visible sidecar session and post-run observation input", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    const submitted: Array<{threadId: string; source: string; text: string}> = [];
    await createMainSession({sessionStore, threadStore});
    await threadStore.appendRuntimeMessage("thread-main", {
      origin: "input",
      message: stringToUserMessage("old message outside run"),
      source: "tui",
    });
    await threadStore.enqueueInput("thread-main", {
      message: stringToUserMessage("VAT XML"),
      source: "tui",
    });
    const run = await threadStore.createRun("thread-main");
    const appliedInputs = await threadStore.applyPendingInputs("thread-main");
    const assistant = await threadStore.appendRuntimeMessage("thread-main", {
      message: message("handled run"),
      source: "assistant",
      runId: run.id,
    });
    const toolResult = await threadStore.appendRuntimeMessage("thread-main", {
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "lookup",
        content: [{type: "text", text: "lookup result"}],
        isError: false,
        timestamp: Date.now(),
      },
      source: "tool:lookup",
      runId: run.id,
    });
    const runtime = await threadStore.appendRuntimeMessage("thread-main", {
      message: stringToUserMessage("runtime nudge"),
      source: "runtime",
      runId: run.id,
    });
    const finishedRun = await threadStore.completeRun(run.id);
    const mainThread = await threadStore.getThread("thread-main");

    const service = new IntuitionSidecarService({
      sessionStore,
      threadStore,
      runtime: {
        submitInput: async (threadId, payload) => {
          submitted.push({
            threadId,
            source: payload.source,
            text: typeof payload.message.content === "string" ? payload.message.content : "",
          });
          await threadStore.enqueueInput(threadId, payload);
        },
      },
    });

    await service.afterRunFinish({
      run: finishedRun,
      thread: mainThread,
      messages: [...appliedInputs, assistant, toolResult, runtime],
      signal: new AbortController().signal,
    });

    const sessions = await sessionStore.listAgentSessions("panda");
    const sidecar = sessions.find((session) => session.kind === "sidecar");
    expect(sidecar).toBeDefined();
    expect(sessions.map((session) => session.kind)).toContain("sidecar");
    expect(submitted).toMatchObject([{
      threadId: sidecar?.currentThreadId,
      source: INTUITION_OBSERVATION_SOURCE,
    }]);
    expect(submitted[0]?.text).toContain("Messages in finished run:");
    expect(submitted[0]?.text).toContain("VAT XML");
    expect(submitted[0]?.text).toContain("handled run");
    expect(submitted[0]?.text).toContain("lookup result");
    expect(submitted[0]?.text).toContain("runtime nudge");
    expect(submitted[0]?.text).not.toContain("old message outside run");
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
    const run = await threadStore.createRun("sidecar-thread");
    const appliedInputs = await threadStore.applyPendingInputs("sidecar-thread");
    const assistant = await threadStore.appendRuntimeMessage("sidecar-thread", {
      message: message("observed"),
      source: "assistant",
      runId: run.id,
    });
    const finishedRun = await threadStore.completeRun(run.id);
    const sidecarThread = await threadStore.getThread("sidecar-thread");
    const service = new IntuitionSidecarService({
      sessionStore,
      threadStore,
      runtime: {submitInput: submitted},
    });

    await service.afterRunFinish({
      run: finishedRun,
      thread: sidecarThread,
      messages: [...appliedInputs, assistant],
      signal: new AbortController().signal,
    });

    expect(submitted).not.toHaveBeenCalled();
  });

  it("does not observe failed or empty runs", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    const submitted = vi.fn();
    await createMainSession({sessionStore, threadStore});
    const service = new IntuitionSidecarService({
      sessionStore,
      threadStore,
      runtime: {submitInput: submitted},
    });

    const failedRun = await threadStore.createRun("thread-main");
    const failed = await threadStore.failRunIfRunning(failedRun.id, "provider failed");
    const completedRun = await threadStore.createRun("thread-main");
    const completed = await threadStore.completeRun(completedRun.id);
    const thread = await threadStore.getThread("thread-main");

    await service.afterRunFinish({
      run: failed!,
      thread,
      messages: [await threadStore.appendRuntimeMessage("thread-main", {
        message: message("failed answer"),
        source: "assistant",
        runId: failedRun.id,
      })],
      signal: new AbortController().signal,
    });
    await service.afterRunFinish({
      run: completed,
      thread,
      messages: [],
      signal: new AbortController().signal,
    });

    expect(submitted).not.toHaveBeenCalled();
  });

  it("observes only after the main run completes with current-run messages", async () => {
    const threadStore = new TestThreadRuntimeStore();
    await threadStore.createThread({
      id: "thread-main",
      sessionId: "session-main",
      context: {
        sessionId: "session-main",
        agentKey: "panda",
      },
    });
    const runtime = createMockRuntime(
      createAssistantMessage([{
        type: "toolCall",
        id: "call-1",
        name: "echo",
        arguments: {message: "tool payload"},
      }]),
      message("after tool"),
      message("Nothing else to do."),
    );
    const observed = vi.fn();
    const coordinator = new ThreadRuntimeCoordinator({
      store: threadStore,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: () => ({
        agent: new Agent({
          name: "panda",
          instructions: "Use tools.",
          tools: [new EchoTool()],
        }),
        runtime,
      }),
      afterRunFinish: observed,
    });

    await coordinator.submitInput("thread-main", {
      message: stringToUserMessage("VAT XML"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-main");

    expect(runtime.complete).toHaveBeenCalledTimes(3);
    expect(observed).toHaveBeenCalledTimes(1);
    const observation = observed.mock.calls[0]?.[0];
    expect(observation.run.status).toBe("completed");
    expect(observation.messages.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "tool:echo",
      "assistant",
      "runtime",
      "assistant",
    ]);
    const firstRequest = runtime.complete.mock.calls[0]?.[0];
    expect(JSON.stringify(firstRequest.context.messages)).not.toContain("[Internal intuition note]");
    const transcript = await threadStore.loadTranscript("thread-main");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "tool:echo",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

  it("continues the main run when the post-run sidecar hook fails", async () => {
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
      afterRunFinish: async () => {
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
    const run = await threadStore.createRun("thread-main");
    const appliedInputs = await threadStore.applyPendingInputs("thread-main");
    const assistant = await threadStore.appendRuntimeMessage("thread-main", {
      message: message("handled intuition"),
      source: "assistant",
      runId: run.id,
    });
    const finishedRun = await threadStore.completeRun(run.id);
    const service = new IntuitionSidecarService({
      sessionStore,
      threadStore,
      runtime: {submitInput: submitted},
    });

    await service.afterRunFinish({
      run: finishedRun,
      thread: await threadStore.getThread("thread-main"),
      messages: [...appliedInputs, assistant],
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
