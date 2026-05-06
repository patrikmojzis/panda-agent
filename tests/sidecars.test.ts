import {describe, expect, it, vi} from "vitest";
import type {AssistantMessage, ToolCall, ToolResultMessage} from "@mariozechner/pi-ai";

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
  SIDECAR_EVENT_SOURCE,
  SIDECAR_INPUT_SOURCE,
  type SidecarDefinitionRecord,
} from "../src/domain/sidecars/index.js";
import {SidecarService} from "../src/app/runtime/sidecars.js";
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
  readonly createdSessionIds: string[] = [];

  async ensureSchema(): Promise<void> {}

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = Date.now();
    const session: SessionRecord = {
      ...input,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(session.id, session);
    this.createdSessionIds.push(session.id);
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

class MemorySidecarRepo {
  constructor(private readonly records: readonly SidecarDefinitionRecord[]) {}

  async getDefinition(agentKey: string, sidecarKey: string): Promise<SidecarDefinitionRecord> {
    const found = this.records.find((record) => record.agentKey === agentKey && record.sidecarKey === sidecarKey);
    if (!found) {
      throw new Error(`Unknown sidecar ${agentKey}/${sidecarKey}.`);
    }
    return found;
  }

  async listAgentDefinitions(agentKey: string, options: { enabled?: boolean } = {}): Promise<readonly SidecarDefinitionRecord[]> {
    return this.records.filter((record) => {
      return record.agentKey === agentKey
        && (options.enabled === undefined || record.enabled === options.enabled);
    });
  }
}

function sidecar(
  overrides: Partial<SidecarDefinitionRecord> = {},
): SidecarDefinitionRecord {
  const now = Date.now();
  return {
    agentKey: "panda",
    sidecarKey: "memory_guard",
    displayName: "Memory Guard",
    enabled: true,
    prompt: "Check memory quietly. Call send_to_main only for material corrections.",
    triggers: ["after_run_finish"],
    toolset: "readonly",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
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

describe("Sidecars", () => {
  it("creates a visible sidecar session and post-run event input", async () => {
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
    const finishedRun = await threadStore.completeRun(run.id);
    const mainThread = await threadStore.getThread("thread-main");

    const service = new SidecarService({
      sessionStore,
      threadStore,
      sidecarRepo: new MemorySidecarRepo([sidecar()]),
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
      messages: [...appliedInputs, assistant],
      signal: new AbortController().signal,
    });

    const sessions = await sessionStore.listAgentSessions("panda");
    const sidecarSession = sessions.find((session) => session.kind === "sidecar");
    expect(sidecarSession).toBeDefined();
    expect(submitted).toMatchObject([{
      threadId: sidecarSession?.currentThreadId,
      source: SIDECAR_EVENT_SOURCE,
    }]);
    expect(submitted[0]?.text).toContain("Trigger: after_run_finish");
    expect(submitted[0]?.text).toContain(`Main run: ${finishedRun.id}`);
    expect(submitted[0]?.text).toContain(`Main thread: ${mainThread.id}`);
    expect(submitted[0]?.text).toMatch(/session\.messages\/session\.tool_results/i);
    expect(submitted[0]?.text).not.toContain("VAT XML");
    expect(submitted[0]?.text).not.toContain("handled run");
    expect(submitted[0]?.text).not.toContain("old message outside run");
  });

  it("does not trigger sidecars recursively", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    const submitted = vi.fn();
    await sessionStore.createSession({
      id: "sidecar-session",
      agentKey: "panda",
      kind: "sidecar",
      currentThreadId: "sidecar-thread",
      metadata: {
        sidecar: {
          kind: "sidecar",
          parentSessionId: "session-main",
          sidecarKey: "memory_guard",
        },
      },
    });
    await threadStore.createThread({
      id: "sidecar-thread",
      sessionId: "sidecar-session",
      context: {
        sessionId: "sidecar-session",
        agentKey: "panda",
        sidecar: {
          kind: "sidecar",
          parentSessionId: "session-main",
          sidecarKey: "memory_guard",
        },
      },
    });
    await threadStore.enqueueInput("sidecar-thread", {
      message: stringToUserMessage("observe"),
      source: SIDECAR_EVENT_SOURCE,
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
    const service = new SidecarService({
      sessionStore,
      threadStore,
      sidecarRepo: new MemorySidecarRepo([sidecar()]),
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

  it("skips failed, empty, and sidecar-only runs", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    const submitted = vi.fn();
    await createMainSession({sessionStore, threadStore});
    const service = new SidecarService({
      sessionStore,
      threadStore,
      sidecarRepo: new MemorySidecarRepo([sidecar()]),
      runtime: {submitInput: submitted},
    });

    const failedRun = await threadStore.createRun("thread-main");
    const failed = await threadStore.failRunIfRunning(failedRun.id, "provider failed");
    const completedRun = await threadStore.createRun("thread-main");
    const completed = await threadStore.completeRun(completedRun.id);
    const sidecarOnlyRun = await threadStore.createRun("thread-main");
    const sidecarInput = await threadStore.appendRuntimeMessage("thread-main", {
      origin: "input",
      message: stringToUserMessage("[Sidecar note: memory_guard]\nCheck tax memory."),
      source: SIDECAR_INPUT_SOURCE,
      runId: sidecarOnlyRun.id,
    });
    const sidecarOnlyAssistant = await threadStore.appendRuntimeMessage("thread-main", {
      message: message("handled sidecar"),
      source: "assistant",
      runId: sidecarOnlyRun.id,
    });
    const sidecarOnly = await threadStore.completeRun(sidecarOnlyRun.id);
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
    await service.afterRunFinish({
      run: sidecarOnly,
      thread,
      messages: [sidecarInput, sidecarOnlyAssistant],
      signal: new AbortController().signal,
    });

    expect(submitted).not.toHaveBeenCalled();
  });

  it("dispatches checkpoint triggers without exposing sidecar notes as current input", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    const submitted: Array<{source: string; text: string}> = [];
    await createMainSession({sessionStore, threadStore});
    await threadStore.enqueueInput("thread-main", {
      message: stringToUserMessage("Run lookup."),
      source: "tui",
    });
    const run = await threadStore.createRun("thread-main");
    const appliedInputs = await threadStore.applyPendingInputs("thread-main");
    const assistant = await threadStore.appendRuntimeMessage("thread-main", {
      message: createAssistantMessage([{
        type: "toolCall",
        id: "call-1",
        name: "echo",
        arguments: {message: "payload"},
      }]),
      source: "assistant",
      runId: run.id,
    });
    const checkpoint = {
      phase: "after_tool_result" as const,
      runContext: {} as never,
      toolCall: {
        type: "toolCall",
        id: "call-1",
        name: "echo",
        arguments: {message: "payload"},
      } satisfies ToolCall,
      toolResult: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "echo",
        content: [{type: "text", text: "ok"}],
        isError: false,
        timestamp: Date.now(),
      } satisfies ToolResultMessage,
      remainingToolCalls: [],
    };
    const service = new SidecarService({
      sessionStore,
      threadStore,
      sidecarRepo: new MemorySidecarRepo([sidecar({triggers: ["after_tool_result"]})]),
      runtime: {
        submitInput: async (_threadId, payload) => {
          submitted.push({
            source: payload.source,
            text: typeof payload.message.content === "string" ? payload.message.content : "",
          });
        },
      },
    });

    await service.afterCheckpoint({
      run,
      thread: await threadStore.getThread("thread-main"),
      checkpoint,
      messages: [...appliedInputs, assistant],
      signal: new AbortController().signal,
    });

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.source).toBe(SIDECAR_EVENT_SOURCE);
    expect(submitted[0]?.text).toContain("Trigger: after_tool_result");
    expect(submitted[0]?.text).toContain("Tool result: echo");
  });

  it("shares sidecar thread creation across overlapping trigger dispatches", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    const submitted: Array<{source: string}> = [];
    await createMainSession({sessionStore, threadStore});
    await threadStore.enqueueInput("thread-main", {
      message: stringToUserMessage("Run lookup."),
      source: "tui",
    });
    const run = await threadStore.createRun("thread-main");
    const appliedInputs = await threadStore.applyPendingInputs("thread-main");
    const assistant = await threadStore.appendRuntimeMessage("thread-main", {
      message: message("answer"),
      source: "assistant",
      runId: run.id,
    });
    const finishedRun = await threadStore.completeRun(run.id);
    const service = new SidecarService({
      sessionStore,
      threadStore,
      sidecarRepo: new MemorySidecarRepo([sidecar({
        triggers: ["after_assistant", "after_run_finish"],
      })]),
      runtime: {
        submitInput: async (_threadId, payload) => {
          submitted.push({source: payload.source});
        },
      },
    });

    await Promise.all([
      service.afterRunFinish({
        run: finishedRun,
        thread: await threadStore.getThread("thread-main"),
        messages: [...appliedInputs, assistant],
        signal: new AbortController().signal,
      }),
      service.afterCheckpoint({
        run,
        thread: await threadStore.getThread("thread-main"),
        checkpoint: {
          phase: "after_assistant",
          runContext: {} as never,
          assistantMessage: assistant.message as AssistantMessage,
          toolCalls: [],
        },
        messages: [...appliedInputs, assistant],
        signal: new AbortController().signal,
      }),
    ]);

    expect(submitted).toEqual([
      {source: SIDECAR_EVENT_SOURCE},
      {source: SIDECAR_EVENT_SOURCE},
    ]);
    expect(sessionStore.createdSessionIds.filter((id) => id.startsWith("sidecar-memory_guard-"))).toHaveLength(1);
  });

  it("runs coordinator sidecar hooks opportunistically", async () => {
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
    const beforeRunStep = vi.fn();
    const afterCheckpoint = vi.fn();
    const afterRunFinish = vi.fn();
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
      beforeRunStep,
      afterCheckpoint,
      afterRunFinish,
    });

    await coordinator.submitInput("thread-main", {
      message: stringToUserMessage("VAT XML"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-main");

    expect(runtime.complete).toHaveBeenCalledTimes(3);
    expect(beforeRunStep).toHaveBeenCalled();
    expect(afterCheckpoint).toHaveBeenCalledTimes(2);
    expect(afterCheckpoint.mock.calls[0]?.[0].messages.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
    ]);
    expect(afterCheckpoint.mock.calls[1]?.[0].messages.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "tool:echo",
    ]);
    expect(afterRunFinish).toHaveBeenCalledTimes(1);
    const finish = afterRunFinish.mock.calls[0]?.[0];
    expect(finish.messages.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "tool:echo",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

  it("continues the main run when sidecar hooks fail", async () => {
    const threadStore = new TestThreadRuntimeStore();
    await threadStore.createThread({
      id: "thread-main",
      sessionId: "session-main",
      context: {
        sessionId: "session-main",
        agentKey: "panda",
      },
    });
    const runtime = createMockRuntime(message("handled without sidecar"));
    const coordinator = new ThreadRuntimeCoordinator({
      store: threadStore,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: () => definition(runtime),
      beforeRunStep: async () => {
        throw new Error("sidecar unavailable");
      },
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
  });

  it("wakes the main thread when a sidecar sends a note", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    await createMainSession({sessionStore, threadStore});
    const runtime = createMockRuntime(message("noticed sidecar"));
    const coordinator = new ThreadRuntimeCoordinator({
      store: threadStore,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: () => definition(runtime),
    });
    const service = new SidecarService({
      sessionStore,
      threadStore,
      sidecarRepo: new MemorySidecarRepo([sidecar()]),
      runtime: {
        submitInput: (threadId, payload, mode) => coordinator.submitInput(threadId, payload, mode),
      },
    });

    await service.sendToMain({
      parentThreadId: "thread-main",
      parentRunId: "run-late",
      sidecarKey: "memory_guard",
      sidecarThreadId: "sidecar-thread",
      message: "Check the apartment wiki before giving drawdown dates.",
    });
    await coordinator.waitForIdle("thread-main");

    const transcript = await threadStore.loadTranscript("thread-main");
    expect(transcript.map((entry) => entry.source)).toEqual([
      SIDECAR_INPUT_SOURCE,
      "assistant",
    ]);
    expect(runtime.complete).toHaveBeenCalledTimes(1);
  });

  it("uses the configured sidecar model, prompt, and readonly tool set", async () => {
    const sessionStore = new MemorySessionStore();
    const threadStore = new TestThreadRuntimeStore();
    await sessionStore.createSession({
      id: "sidecar-session",
      agentKey: "panda",
      kind: "sidecar",
      currentThreadId: "sidecar-thread",
      metadata: {
        sidecar: {
          kind: "sidecar",
          parentSessionId: "session-main",
          sidecarKey: "memory_guard",
        },
      },
    });
    await threadStore.createThread({
      id: "sidecar-thread",
      sessionId: "sidecar-session",
      context: {
        sessionId: "sidecar-session",
        agentKey: "panda",
        sidecar: {
          kind: "sidecar",
          parentSessionId: "session-main",
          sidecarKey: "memory_guard",
        },
      },
    });
    const service = new SidecarService({
      sessionStore,
      threadStore,
      sidecarRepo: new MemorySidecarRepo([sidecar({
        prompt: "Guard the wiki.",
        model: "openai-codex/gpt-5.4",
        thinking: "high",
      })]),
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
        BRAVE_API_KEY: "test-key",
      },
    });

    const resolved = await service.resolveDefinition(
      await threadStore.getThread("sidecar-thread"),
      await sessionStore.getSession("sidecar-session"),
    );

    expect(resolved.model).toBe("openai-codex/gpt-5.4");
    expect(resolved.thinking).toBe("high");
    expect(resolved.promptCacheKey).toMatch(/^sidecar:memory_guard:[a-f0-9]{12}$/);
    expect(resolved.promptCacheKey?.length).toBeLessThanOrEqual(64);
    expect(resolved.agent.instructions).toBe("Guard the wiki.");
    expect(resolved.agent.tools.map((tool) => tool.name).sort()).toEqual([
      "brave_search",
      "current_datetime",
      "postgres_readonly_query",
      "send_to_main",
      "web_fetch",
      "wiki",
    ]);
  });
});
