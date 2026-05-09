import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@mariozechner/pi-ai";
import {
    Agent,
    BackgroundJobStatusTool,
    BackgroundJobWaitTool,
    BashTool,
    type LlmRuntime,
    OutboundTool,
    PiAiRuntime,
    RunContext,
    stringToUserMessage,
    Thread,
    Tool,
    z,
} from "../src/index.js";
import {buildBackgroundToolThreadInput} from "../src/app/runtime/background-tool-thread-input.js";
import {
    AUTO_COMPACT_BREAKER_COOLDOWN_MS,
    createCompactBoundaryMessage,
    type CreateThreadInput,
    type ResolvedThreadDefinition,
    type ThreadDefinitionResolver,
    type ThreadMessageRecord,
    type ThreadRecord,
    ThreadRuntimeCoordinator,
} from "../src/domain/threads/runtime/index.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

const TEST_MODELS = vi.hoisted(() => ({
  window350: "openai/panda-test-window-350",
  window620: "openai/panda-test-window-620",
  window1000: "openai/panda-test-window-1000",
  window5000: "openai/panda-test-window-5000",
  operatingWindowByModel: new Map<string, number>([
    ["openai/panda-test-window-350", 350],
    ["openai/panda-test-window-620", 620],
    ["openai/panda-test-window-1000", 1_000],
    ["openai/panda-test-window-5000", 5_000],
  ]),
}));

vi.mock("../src/kernel/models/model-context-policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/kernel/models/model-context-policy.js")>();

  return {
    ...actual,
    resolveModelRuntimeBudget(model?: string) {
      const operatingWindow = model ? TEST_MODELS.operatingWindowByModel.get(model) : undefined;
      if (operatingWindow === undefined) {
        return actual.resolveModelRuntimeBudget(model);
      }

      const modelId = model.includes("/") ? model.slice(model.indexOf("/") + 1) : model;
      const policy = actual.resolveModelContextPolicy(model, {
        rules: [{
          kind: "exact",
          match: modelId,
          hardWindow: operatingWindow,
          operatingWindow,
          compactAtPercent: 85,
        }],
        fallback: actual.DEFAULT_MODEL_CONTEXT_POLICY,
      });

      return {
        ...policy,
        compactTriggerTokens: actual.getCompactTriggerTokens({
          operatingWindow: policy.operatingWindow,
          compactAtPercent: policy.compactAtPercent,
        }),
      };
    },
  };
});

const TEST_MODEL_WINDOW_350 = TEST_MODELS.window350;
const TEST_MODEL_WINDOW_620 = TEST_MODELS.window620;
const TEST_MODEL_WINDOW_1000 = TEST_MODELS.window1000;
const TEST_MODEL_WINDOW_5000 = TEST_MODELS.window5000;

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

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

class SlowTool extends Tool<typeof SlowTool.schema> {
  name = "slow";
  description = "Wait for a deferred result";
  static schema = z.object({
    message: z.string(),
  });
  schema = SlowTool.schema;

  constructor(
    private readonly started: ReturnType<typeof createDeferred<void>>,
    private readonly release: ReturnType<typeof createDeferred<{ done: string }>>,
  ) {
    super();
  }

  async handle(): Promise<{ done: string }> {
    this.started.resolve();
    return this.release.promise;
  }
}

class SignalAwareTool extends Tool<typeof SignalAwareTool.schema> {
  name = "signal-aware";
  description = "Expose whether a signal is present";
  static schema = z.object({});
  schema = SignalAwareTool.schema;

  async handle(
    _args: z.output<typeof SignalAwareTool.schema>,
    run: RunContext,
  ): Promise<{ hasSignal: boolean }> {
    return {
      hasSignal: run.signal instanceof AbortSignal,
    };
  }
}

class CrashTool extends Tool<typeof CrashTool.schema> {
  name = "crash";
  description = "Throw a plain error";
  static schema = z.object({});
  schema = CrashTool.schema;

  async handle(): Promise<never> {
    throw new Error("crash-tool boom");
  }
}

class CompleteRunBlockingStore extends TestThreadRuntimeStore {
  constructor(
    private readonly entered: ReturnType<typeof createDeferred<void>>,
    private readonly release: ReturnType<typeof createDeferred<void>>,
  ) {
    super();
  }

  override async completeRun(runId: string) {
    this.entered.resolve();
    await this.release.promise;
    return super.completeRun(runId);
  }
}

class FailRunBlockingStore extends TestThreadRuntimeStore {
  constructor(
    private readonly entered: ReturnType<typeof createDeferred<void>>,
    private readonly release: ReturnType<typeof createDeferred<void>>,
  ) {
    super();
  }

  override async failRunIfRunning(runId: string, error?: string) {
    this.entered.resolve();
    await this.release.promise;
    return super.failRunIfRunning(runId, error);
  }
}

class DeferredRuntime implements LlmRuntime {
  readonly complete = vi.fn(async () => {
    const next = this.responses.shift();
    if (!next) {
      throw new Error("No more runtime responses queued");
    }

    return next;
  });
  readonly stream = vi.fn(() => {
    throw new Error("Streaming was not expected in this test");
  });

  private readonly responses: Promise<AssistantMessage>[] = [];

  queue(response: AssistantMessage | Promise<AssistantMessage>): void {
    this.responses.push(Promise.resolve(response));
  }
}

class SelectiveLeaseManager {
  private readonly blockedThreads: ReadonlySet<string>;

  constructor(blockedThreads: readonly string[] = []) {
    this.blockedThreads = new Set(blockedThreads);
  }

  async tryAcquire(threadId: string) {
    if (this.blockedThreads.has(threadId)) {
      return null;
    }

    return {
      threadId,
      release: async () => {},
    };
  }
}

class SharedLeaseManager {
  private readonly activeThreads = new Set<string>();

  async tryAcquire(threadId: string) {
    if (this.activeThreads.has(threadId)) {
      return null;
    }

    this.activeThreads.add(threadId);
    return {
      threadId,
      release: async () => {
        this.activeThreads.delete(threadId);
      },
    };
  }
}

class BlockedCountingLeaseManager {
  attempts = 0;

  async tryAcquire() {
    this.attempts += 1;
    return null;
  }
}

class TestThreadDefinitionRegistry {
  private readonly resolvers = new Map<string, ThreadDefinitionResolver>();

  register(agentKey: string, definition: ResolvedThreadDefinition | ThreadDefinitionResolver): this {
    this.resolvers.set(agentKey, typeof definition === "function" ? definition : async () => definition);
    return this;
  }

  resolve(thread: ThreadRecord): Promise<ResolvedThreadDefinition> {
    const agentKey = readAgentKeyFromThreadContext(thread);
    const resolver = this.resolvers.get(agentKey);
    if (!resolver) {
      throw new Error(`No thread definition registered for agent key ${agentKey}.`);
    }

    return Promise.resolve(resolver(thread));
  }
}

function readAgentKeyFromThreadContext(thread: ThreadRecord): string {
  const context = thread.context;
  if (!context || typeof context !== "object") {
    throw new Error(`Thread ${thread.id} is missing runtime session context.`);
  }

  const agentKey = "agentKey" in context && typeof context.agentKey === "string"
    ? context.agentKey.trim()
    : "";
  if (!agentKey) {
    throw new Error(`Thread ${thread.id} is missing agentKey in runtime session context.`);
  }

  return agentKey;
}

async function createRuntimeThread(
  store: TestThreadRuntimeStore,
  input: Omit<CreateThreadInput, "sessionId" | "context"> & {
    agentKey: string;
    sessionId?: string;
    context?: Record<string, unknown>;
  },
): Promise<ThreadRecord> {
  const {
    id,
    agentKey,
    sessionId = `${id}-session`,
    context,
    ...threadInput
  } = input;

  return store.createThread({
    id,
    sessionId,
    context: {
      sessionId,
      agentKey,
      ...(context ?? {}),
    },
    ...threadInput,
  });
}

async function seedAutoCompactionTranscript(store: TestThreadRuntimeStore, threadId: string): Promise<void> {
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("old request " + "a".repeat(2_400)),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId);
  await store.appendRuntimeMessage(threadId, {
    message: message("old reply"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep one"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply one"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep two"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply two"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep three"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply three"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep four"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply four"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep five"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply five"),
    source: "assistant",
  });
}

describe("ThreadRuntimeCoordinator", () => {
  it("clears thinking when updated to null", async () => {
    const store = new TestThreadRuntimeStore();

    await createRuntimeThread(store, {
      id: "thread-thinking",
      agentKey: "panda",
      thinking: "medium",
    });

    const updated = await store.updateThread("thread-thinking", { thinking: null });

    expect(updated.thinking).toBeUndefined();
    expect((await store.getThread("thread-thinking")).thinking).toBeUndefined();
  });

  it("passes the latest input message id into tool context", async () => {
    let capturedContext: unknown;
    class CaptureContextTool extends Tool<typeof CaptureContextTool.schema> {
      name = "capture-context";
      description = "Capture runtime context";
      static schema = z.object({});
      schema = CaptureContextTool.schema;

      async handle(
        _args: z.output<typeof CaptureContextTool.schema>,
        run: RunContext,
      ): Promise<{ ok: boolean }> {
        capturedContext = run.context;
        return {ok: true};
      }
    }

    const runtime = createMockRuntime(
      createAssistantMessage([{
        type: "toolCall",
        id: "call_capture_context",
        name: "capture-context",
        arguments: {},
      }]),
      message("done"),
    );
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("input-message-context", {
      agent: new Agent({
        name: "input-message-context",
        instructions: "Use the capture tool.",
        tools: [new CaptureContextTool()],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-input-message-context",
      agentKey: "input-message-context",
    });
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-input-message-context", {
      message: stringToUserMessage("capture this input"),
      source: "heartbeat",
      identityId: "identity-1",
    });
    await coordinator.waitForIdle("thread-input-message-context");

    const input = (await store.loadTranscript("thread-input-message-context"))
      .find((entry) => entry.origin === "input");
    expect(input).toBeDefined();
    expect(capturedContext).toMatchObject({
      currentInput: {
        messageId: input!.id,
        source: "heartbeat",
        identityId: "identity-1",
      },
    });
  });

  it("grants one extra idle reroll before letting a run go idle", async () => {
    const responses = [
      message("first reply"),
      message("second pass"),
    ];
    const runtime: LlmRuntime & { complete: ReturnType<typeof vi.fn> } = {
      complete: vi.fn().mockImplementation(async (request) => {
        const lastMessage = request.context.messages.at(-1);
        if (lastMessage?.role === "assistant") {
          throw new Error("assistant-prefill not allowed");
        }

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
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("idle-reroll", {
      agent: new Agent({
        name: "idle-reroll",
        instructions: "Reply plainly.",
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-idle-reroll",
      agentKey: "idle-reroll",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-idle-reroll", {
      message: stringToUserMessage("start"),
      source: "tui",
    });

    await coordinator.waitForIdle("thread-idle-reroll");

    expect(runtime.complete).toHaveBeenCalledTimes(2);
    expect(runtime.complete.mock.calls[1]?.[0].context.messages.at(-1)?.role).toBe("user");
    expect(String(runtime.complete.mock.calls[0]?.[0].context.messages.at(-1)?.content ?? "")).not.toContain("<runtime-autonomy-context>");
    expect(String(runtime.complete.mock.calls[1]?.[0].context.messages.at(-1)?.content ?? "")).toContain("<runtime-autonomy-context>");
    expect(String(runtime.complete.mock.calls[1]?.[0].context.messages.at(-1)?.content ?? "")).toContain("new_external_input: no");

    const transcript = await store.loadTranscript("thread-idle-reroll");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

  it("does not grant an idle reroll for heartbeat inputs", async () => {
    const runtime = createMockRuntime(message("heartbeat handled"));
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("heartbeat-no-reroll", {
      agent: new Agent({
        name: "heartbeat-no-reroll",
        instructions: "Reply plainly.",
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-heartbeat-no-reroll",
      agentKey: "heartbeat-no-reroll",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-heartbeat-no-reroll", {
      message: stringToUserMessage("[Heartbeat]"),
      source: "heartbeat",
      metadata: {
        heartbeat: {
          kind: "interval",
        },
      },
    });

    await coordinator.waitForIdle("thread-heartbeat-no-reroll");

    expect(runtime.complete).toHaveBeenCalledTimes(1);

    const transcript = await store.loadTranscript("thread-heartbeat-no-reroll");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "heartbeat",
      "assistant",
    ]);
  });

  it("re-arms the idle reroll when a new input lands during the extra pass", async () => {
    const runtime = new DeferredRuntime();
    const extraPass = createDeferred<AssistantMessage>();
    runtime.queue(message("first wave reply"));
    runtime.queue(extraPass.promise);
    runtime.queue(message("second wave reply"));
    runtime.queue(message("second wave extra pass"));

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("idle-reroll-reset", {
      agent: new Agent({
        name: "idle-reroll-reset",
        instructions: "Reply plainly.",
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-idle-reroll-reset",
      agentKey: "idle-reroll-reset",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-idle-reroll-reset", {
      message: stringToUserMessage("first wave"),
      source: "tui",
    });

    await waitFor(() => runtime.complete.mock.calls.length === 2);

    await coordinator.submitInput("thread-idle-reroll-reset", {
      message: stringToUserMessage("second wave"),
      source: "telegram",
      channelId: "chat-2",
      externalMessageId: "msg-2",
      actorId: "user-2",
    });

    extraPass.resolve(message("first wave extra pass"));

    await coordinator.waitForIdle("thread-idle-reroll-reset");

    expect(runtime.complete).toHaveBeenCalledTimes(4);
    expect(String(runtime.complete.mock.calls[0]?.[0].context.messages.at(-1)?.content ?? "")).not.toContain("<runtime-autonomy-context>");
    expect(String(runtime.complete.mock.calls[1]?.[0].context.messages.at(-1)?.content ?? "")).toContain("<runtime-autonomy-context>");
    expect(String(runtime.complete.mock.calls[2]?.[0].context.messages.at(-1)?.content ?? "")).toContain("second wave");
    expect(String(runtime.complete.mock.calls[3]?.[0].context.messages.at(-1)?.content ?? "")).toContain("<runtime-autonomy-context>");

    const transcript = await store.loadTranscript("thread-idle-reroll-reset");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "runtime",
      "assistant",
      "telegram",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

  it("keeps background bash records across later runs in the same thread and marks unfinished jobs lost on startup", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-thread-runtime-bg-"));
    try {
      const store = new TestThreadRuntimeStore();
      await createRuntimeThread(store, {
        id: "thread-bg-runtime",
        agentKey: "panda",
      });
      const service = new BackgroundToolJobService({ store });
      const bash = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        jobService: service,
      });
      const wait = new BackgroundJobWaitTool({ service });
      const status = new BackgroundJobStatusTool({ service });

      const runContext = (context: Record<string, unknown>) => new RunContext({
        agent: new Agent({
          name: "bg-runtime-agent",
          instructions: "Use tools.",
        }),
        turn: 1,
        maxTurns: 5,
        messages: [],
        context,
      });

      const firstRunContext = {
        threadId: "thread-bg-runtime",
        runId: "run-1",
        cwd: workspace,
        shell: {
          cwd: workspace,
          env: {},
        },
      };

      const started = await bash.run(
        { command: "sleep 0.15 && printf hello", background: true },
        runContext(firstRunContext),
      );
      const jobId = String((started as {jobId: string}).jobId);

      const finished = await wait.run(
        { jobId, timeoutMs: 1_000 },
        runContext(firstRunContext),
      );
      expect((finished as {status: string; stdout: string}).status).toBe("completed");

      const secondRunContext = {
        ...firstRunContext,
        runId: "run-2",
      };
      const completedLater = await status.run(
        { jobId },
        runContext(secondRunContext),
      );

      expect((completedLater as {status: string; stdout: string}).status).toBe("completed");
      expect((completedLater as {stdout: string}).stdout).toBe("hello");
      expect(await store.listToolJobs("thread-bg-runtime")).toHaveLength(1);
      expect((await store.getToolJob(jobId)).runId).toBe("run-1");

      const orphan = await bash.run(
        { command: "sleep 10", background: true },
        runContext(secondRunContext),
      );
      const orphanJobId = String((orphan as {jobId: string}).jobId);

      expect(await store.markRunningToolJobsLost("runtime restarted")).toBe(1);

      const lost = await status.run(
        { jobId: orphanJobId },
        runContext(secondRunContext),
      );
      expect((lost as {status: string; reason?: string}).status).toBe("lost");
      expect((lost as {reason?: string}).reason).toBe("runtime restarted");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("surfaces queued wake inputs before the next model turn when watcher-owned background jobs finish during an active run", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-thread-runtime-autowake-"));
    try {
      const started = createDeferred<void>();
      const release = createDeferred<{ done: string }>();
      const store = new TestThreadRuntimeStore();
      await createRuntimeThread(store, {
        id: "thread-bg-autowake",
        agentKey: "bg-autowake-agent",
      });

      const service = new BackgroundToolJobService({ store });
      const bash = new BashTool({
        outputDirectory: path.join(workspace, "tool-results"),
        jobService: service,
      });
      const slow = new SlowTool(started, release);

      const runtime: LlmRuntime = {
        complete: vi.fn().mockImplementation(async (request) => {
          const callCount = (runtime.complete as ReturnType<typeof vi.fn>).mock.calls.length;

          if (callCount === 1) {
            return createAssistantMessage([{
              type: "toolCall",
              id: "call_bg_1",
              name: "bash",
              arguments: {
                command: "sleep 0.05 && printf one",
                background: true,
              },
            }]);
          }

          if (callCount === 2) {
            return createAssistantMessage([{
              type: "toolCall",
              id: "call_bg_2",
              name: "bash",
              arguments: {
                command: "sleep 0.05 && printf two",
                background: true,
              },
            }]);
          }

          if (callCount === 3) {
            return createAssistantMessage([{
              type: "toolCall",
              id: "call_slow",
              name: "slow",
              arguments: {
                message: "hold the run open",
              },
            }]);
          }

          if (callCount === 4) {
            expect(request.context.messages.some((entry) => {
              return entry.role === "user"
                && typeof entry.content === "string"
                && entry.content.includes("[Background Tool Event]");
            })).toBe(true);
            return message("noticed the background completion");
          }

          if (callCount === 5) {
            return message("Nothing else to do.");
          }

          throw new Error(`Unexpected runtime call ${callCount}.`);
        }),
        stream: vi.fn(() => {
          throw new Error("Streaming was not expected in this test");
        }),
      };

      const registry = new TestThreadDefinitionRegistry().register("bg-autowake-agent", {
        agent: new Agent({
          name: "bg-autowake-agent",
          instructions: "Use tools.",
          tools: [bash, slow],
        }),
        runtime,
        context: {
          threadId: "thread-bg-autowake",
          cwd: workspace,
          shell: {
            cwd: workspace,
            env: {},
          },
        },
      });

      const coordinator = new ThreadRuntimeCoordinator({
        store,
        leaseManager: new SelectiveLeaseManager(),
        resolveDefinition: (thread) => registry.resolve(thread),
      });
      service.setBackgroundCompletionHandler(async (record) => {
        await coordinator.submitInput(record.threadId, buildBackgroundToolThreadInput(record), "queue");
        await coordinator.wake(record.threadId);
      });

      await coordinator.submitInput("thread-bg-autowake", {
        message: stringToUserMessage("start two background jobs and keep working"),
        source: "tui",
      });

      await started.promise;
      await waitFor(async () => {
        const pendingInputs = await store.listPendingInputs("thread-bg-autowake");
        return pendingInputs.filter((entry) => entry.source === "background_tool").length === 2;
      });

      release.resolve({ done: "released" });
      await coordinator.waitForIdle("thread-bg-autowake");

      const transcript = await store.loadTranscript("thread-bg-autowake");
      expect(transcript.filter((entry) => entry.source === "background_tool")).toHaveLength(2);
      expect(transcript.filter((entry) => entry.source === "background_tool").every((entry) => entry.origin === "input")).toBe(true);
      expect(runtime.complete).toHaveBeenCalledTimes(5);
      expect(transcript.some((entry) => {
        return entry.message.role === "assistant"
          && entry.message.content.some((block) => block.type === "text" && block.text === "noticed the background completion");
      })).toBe(true);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("preserves queued background bash input when another coordinator owns the thread lease", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<{ done: string }>();
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-cross-process-wake",
      agentKey: "cross-wake-agent",
    });

    const runtime: LlmRuntime = {
      complete: vi.fn().mockImplementation(async (request) => {
        const callCount = (runtime.complete as ReturnType<typeof vi.fn>).mock.calls.length;

        if (callCount === 1) {
          return createAssistantMessage([{
            type: "toolCall",
            id: "call_slow",
            name: "slow",
            arguments: {
              message: "hold the lease",
            },
          }]);
        }

        if (callCount === 2) {
          expect(request.context.messages.some((entry) => {
            return entry.role === "user"
              && typeof entry.content === "string"
              && entry.content.includes("[Background Tool Event]");
          })).toBe(true);
          return message("noticed wake from another coordinator");
        }

        if (callCount === 3) {
          return message("Nothing else to do.");
        }

        throw new Error(`Unexpected runtime call ${callCount}.`);
      }),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

    const registry = new TestThreadDefinitionRegistry().register("cross-wake-agent", {
      agent: new Agent({
        name: "cross-wake-agent",
        instructions: "Use tools.",
        tools: [new SlowTool(started, release)],
      }),
      runtime,
    });
    const leaseManager = new SharedLeaseManager();
    const ownerCoordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager,
      resolveDefinition: (thread) => registry.resolve(thread),
    });
    const otherCoordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await ownerCoordinator.submitInput("thread-cross-process-wake", {
      message: stringToUserMessage("start a slow task"),
      source: "tui",
    });

    await started.promise;
    await otherCoordinator.submitInput(
      "thread-cross-process-wake",
      buildBackgroundToolThreadInput({
        id: "job-cross-wake",
        threadId: "thread-cross-process-wake",
        status: "completed",
        command: "printf done",
        mode: "local",
        initialCwd: "/workspace",
        startedAt: Date.now() - 50,
        finishedAt: Date.now(),
        durationMs: 50,
        timedOut: false,
        stdout: "done",
        stderr: "",
        stdoutChars: 4,
        stderrChars: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutPersisted: false,
        stderrPersisted: false,
        trackedEnvKeys: [],
      }),
      "queue",
    );
    await otherCoordinator.wake("thread-cross-process-wake");

    release.resolve({ done: "released" });
    await ownerCoordinator.waitForIdle("thread-cross-process-wake");

    expect(runtime.complete).toHaveBeenCalledTimes(3);
    const transcript = await store.loadTranscript("thread-cross-process-wake");
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "noticed wake from another coordinator");
    })).toBe(true);
  });

  it("waits for pending durable wakes before reporting idle", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-pending-wake-idle",
      agentKey: "pending-wake-agent",
    });

    const runtime = createMockRuntime(
      message("processed pending wake"),
      message("settled after pending wake"),
      message("Nothing else to do."),
    );
    const registry = new TestThreadDefinitionRegistry().register("pending-wake-agent", {
      agent: new Agent({
        name: "pending-wake-agent",
        instructions: "React to runtime events.",
        tools: [],
      }),
      runtime,
    });
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await store.enqueueInput(
      "thread-pending-wake-idle",
      buildBackgroundToolThreadInput({
        id: "job-pending-wake-idle",
        threadId: "thread-pending-wake-idle",
        status: "completed",
        command: "printf done",
        mode: "local",
        initialCwd: "/workspace",
        startedAt: Date.now() - 25,
        finishedAt: Date.now(),
        durationMs: 25,
        timedOut: false,
        stdout: "done",
        stderr: "",
        stdoutChars: 4,
        stderrChars: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutPersisted: false,
        stderrPersisted: false,
        trackedEnvKeys: [],
      }),
      "queue",
    );
    await store.requestWake("thread-pending-wake-idle");

    await coordinator.waitForIdle("thread-pending-wake-idle");

    expect(runtime.complete).toHaveBeenCalledTimes(3);
    const transcript = await store.loadTranscript("thread-pending-wake-idle");
    expect(transcript.some((entry) => entry.origin === "input" && entry.source === "background_tool")).toBe(true);
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "processed pending wake");
    })).toBe(true);
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "settled after pending wake");
    })).toBe(true);
  });

  it("pokes externally enqueued wake inputs", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-external-poke",
      agentKey: "external-poke-agent",
    });

    const runtime = createMockRuntime(
      message("processed external wake"),
      message("Nothing else to do."),
    );
    const registry = new TestThreadDefinitionRegistry().register("external-poke-agent", {
      agent: new Agent({
        name: "external-poke-agent",
        instructions: "React to external events.",
        tools: [],
      }),
      runtime,
    });
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await store.enqueueInput(
      "thread-external-poke",
      {
        message: stringToUserMessage("external gateway wake"),
        source: "gateway",
      },
      "wake",
    );

    await coordinator.poke("thread-external-poke");
    await coordinator.waitForIdle("thread-external-poke");

    expect(runtime.complete).toHaveBeenCalledTimes(2);
    const transcript = await store.loadTranscript("thread-external-poke");
    expect(transcript.some((entry) => entry.origin === "input" && entry.source === "gateway")).toBe(true);
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "processed external wake");
    })).toBe(true);
  });

  it("backs off a poke when another coordinator owns the lease", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-poke-held-lease",
      agentKey: "held-lease-agent",
    });

    const leaseManager = new BlockedCountingLeaseManager();
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager,
      resolveDefinition: async () => {
        throw new Error("resolveDefinition should not be called without a lease");
      },
    });

    await store.enqueueInput(
      "thread-poke-held-lease",
      {
        message: stringToUserMessage("external wake while leased elsewhere"),
        source: "gateway",
      },
      "wake",
    );

    await coordinator.poke("thread-poke-held-lease");

    expect(leaseManager.attempts).toBeLessThanOrEqual(2);
    expect(await store.hasRunnableInputs("thread-poke-held-lease")).toBe(true);
  });

  it("treats pending durable wakes as busy", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-pending-wake-busy",
      agentKey: "busy-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: async () => {
        throw new Error("resolveDefinition should not be called");
      },
    });

    expect(await coordinator.isThreadBusy("thread-pending-wake-busy")).toBe(false);

    await store.requestWake("thread-pending-wake-busy");

    expect(await coordinator.isThreadBusy("thread-pending-wake-busy")).toBe(true);
  });

  it("queues wakes until they are flushed", async () => {
    const runtime = createMockRuntime(
      message("queued reply"),
      message("Nothing else to do."),
    );
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("queued-agent", {
      agent: new Agent({
        name: "queued-agent",
        instructions: "Reply briefly",
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-queued",
      agentKey: "queued-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput(
      "thread-queued",
      {
        message: stringToUserMessage("hello from telegram"),
        source: "telegram",
        channelId: "chat-1",
      },
      "queue",
    );

    expect(await store.listRuns("thread-queued")).toHaveLength(0);
    expect(await store.listPendingInputs("thread-queued")).toHaveLength(1);

    await coordinator.flushQueued("thread-queued");
    await coordinator.waitForIdle("thread-queued");

    expect(runtime.complete).toHaveBeenCalledTimes(2);

    const transcript = await store.loadTranscript("thread-queued");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

  it("keeps queued inputs pending until a flush or new wake cycle starts them", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<{ done: string }>();
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_slow",
          name: "slow",
          arguments: { message: "first" },
        },
      ]),
      message("finished current plan"),
      message("Nothing else to do."),
      message("processed after flush"),
      message("Nothing else to do."),
    );

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("queued-during-run", {
      agent: new Agent({
        name: "queued-during-run",
        instructions: "Use tools when needed",
        tools: [new SlowTool(started, release)],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-queued-during-run",
      agentKey: "queued-during-run",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-queued-during-run", {
      message: stringToUserMessage("start"),
      source: "telegram",
    });

    await started.promise;

    await coordinator.submitInput(
      "thread-queued-during-run",
      {
        message: stringToUserMessage("save this for later"),
        source: "tui",
      },
      "queue",
    );

    release.resolve({ done: "first" });
    await coordinator.waitForIdle("thread-queued-during-run");

    expect(runtime.complete).toHaveBeenCalledTimes(3);
    expect(await store.hasPendingInputs("thread-queued-during-run")).toBe(true);
    expect(await store.hasRunnableInputs("thread-queued-during-run")).toBe(false);

    let transcript = await store.loadTranscript("thread-queued-during-run");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:slow",
      "assistant",
      "runtime",
      "assistant",
    ]);

    await coordinator.flushQueued("thread-queued-during-run");
    await coordinator.waitForIdle("thread-queued-during-run");

    expect(runtime.complete).toHaveBeenCalledTimes(5);
    transcript = await store.loadTranscript("thread-queued-during-run");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:slow",
      "assistant",
      "runtime",
      "assistant",
      "tui",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

  it("restarts wake inputs that arrive during exclusive work once the lease is released", async () => {
    const runtime = createMockRuntime(
      message("processed after exclusive work"),
      message("Nothing else to do."),
    );
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("exclusive-agent", {
      agent: new Agent({
        name: "exclusive-agent",
        instructions: "Reply briefly",
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-exclusive",
      agentKey: "exclusive-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.runExclusively("thread-exclusive", async () => {
      await coordinator.submitInput("thread-exclusive", {
        message: stringToUserMessage("hello after compact"),
        source: "tui",
      });

      expect(runtime.complete).toHaveBeenCalledTimes(0);
      expect(await store.hasRunnableInputs("thread-exclusive")).toBe(true);
    });

    await coordinator.waitForIdle("thread-exclusive");

    expect(runtime.complete).toHaveBeenCalledTimes(2);
    expect((await store.loadTranscript("thread-exclusive")).map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

  it("drains planned tools before replanning when a new input arrives during a tool run", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<{ done: string }>();
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "slow",
          arguments: { message: "first" },
        },
        {
          type: "toolCall",
          id: "call_2",
          name: "echo",
          arguments: { message: "second" },
        },
      ]),
      message("replanned"),
      message("Nothing else to do."),
    );

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("runtime-agent", {
      agent: new Agent({
        name: "runtime-agent",
        instructions: "Use tools when needed",
        tools: [new SlowTool(started, release), new EchoTool()],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-replan",
      agentKey: "runtime-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    const firstWake = coordinator.submitInput(
      "thread-replan",
      {
        message: stringToUserMessage("start the work"),
        source: "telegram",
        channelId: "chat-42",
      },
      "wake",
    );

    await started.promise;

    const secondWake = coordinator.submitInput(
      "thread-replan",
      {
        message: stringToUserMessage("actually, change the plan"),
        source: "tui",
      },
      "wake",
    );

    release.resolve({ done: "first" });

    await Promise.all([firstWake, secondWake]);
    await coordinator.waitForIdle("thread-replan");

    expect(runtime.complete).toHaveBeenCalledTimes(3);

    const transcript = await store.loadTranscript("thread-replan");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:slow",
      "tool:echo",
      "tui",
      "assistant",
      "runtime",
      "assistant",
    ]);

    const echoResult = transcript[3];
    expect(echoResult?.message).toMatchObject({
      role: "toolResult",
      toolName: "echo",
      details: {
        echoed: "second",
      },
    });
  });

  it("still runs the first planned tool when new input arrives after the assistant reply", async () => {
    const runtime = new DeferredRuntime();
    const firstResponse = createDeferred<AssistantMessage>();
    runtime.queue(firstResponse.promise);
    runtime.queue(message("replanned after assistant"));
    runtime.queue(message("Nothing else to do."));
    const slowHandle = vi.fn(async () => ({ echoed: "should not run" }));
    class SpiedEchoTool extends Tool<typeof EchoTool.schema> {
      name = "echo";
      description = "Echo a message";
      static schema = EchoTool.schema;
      schema = EchoTool.schema;

      async handle(args: z.output<typeof EchoTool.schema>) {
        return slowHandle(args);
      }
    }

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("assistant-checkpoint", {
      agent: new Agent({
        name: "assistant-checkpoint",
        instructions: "Use tools when needed",
        tools: [new SpiedEchoTool()],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-after-assistant",
      agentKey: "assistant-checkpoint",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-after-assistant", {
      message: stringToUserMessage("start"),
      source: "telegram",
    });

    await waitFor(() => runtime.complete.mock.calls.length === 1);

    await coordinator.submitInput("thread-after-assistant", {
      message: stringToUserMessage("stop before tools"),
      source: "tui",
    });

    firstResponse.resolve(createAssistantMessage([
      {
        type: "toolCall",
        id: "call_echo",
        name: "echo",
        arguments: { message: "first" },
      },
    ]));

    await coordinator.waitForIdle("thread-after-assistant");

    expect(slowHandle).toHaveBeenCalledTimes(1);

    const transcript = await store.loadTranscript("thread-after-assistant");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:echo",
      "tui",
      "assistant",
      "runtime",
      "assistant",
    ]);
    expect(transcript[2]?.message).toMatchObject({
      role: "toolResult",
      toolName: "echo",
      details: {
        echoed: "should not run",
      },
    });
  });

  it("drains a planned outbound before applying fresh telegram input", async () => {
    const runtime = new DeferredRuntime();
    const firstResponse = createDeferred<AssistantMessage>();
    runtime.queue(firstResponse.promise);
    runtime.queue(message("followed up after the new telegram message"));
    runtime.queue(message("Nothing else to do."));

    const enqueueDelivery = vi.fn(async (input) => ({
      id: "delivery-1",
      ...input,
      status: "pending" as const,
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("outbound-agent", {
      agent: new Agent({
        name: "outbound-agent",
        instructions: "Reply on telegram.",
        tools: [new OutboundTool()],
      }),
      runtime,
      context: {
        threadId: "thread-outbound-drain",
        outboundQueue: {
          enqueueDelivery,
        },
      },
    });

    await createRuntimeThread(store, {
      id: "thread-outbound-drain",
      agentKey: "outbound-agent",
      context: {
        threadId: "thread-outbound-drain",
      },
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-outbound-drain", {
      message: stringToUserMessage("reply to me"),
      source: "telegram",
      channelId: "chat-99",
      externalMessageId: "msg-1",
      actorId: "user-99",
      metadata: {
        route: {
          source: "telegram",
          connectorKey: "bot-main",
          externalConversationId: "chat-99",
          externalActorId: "user-99",
          externalMessageId: "msg-1",
        },
      },
    });

    await waitFor(() => runtime.complete.mock.calls.length === 1);

    await coordinator.submitInput("thread-outbound-drain", {
      message: stringToUserMessage("one more thing"),
      source: "telegram",
      channelId: "chat-99",
      externalMessageId: "msg-2",
      actorId: "user-99",
      metadata: {
        route: {
          source: "telegram",
          connectorKey: "bot-main",
          externalConversationId: "chat-99",
          externalActorId: "user-99",
          externalMessageId: "msg-2",
        },
      },
    });

    firstResponse.resolve(createAssistantMessage([{
      type: "toolCall",
      id: "call_outbound",
      name: "outbound",
      arguments: {
        items: [{ type: "text", text: "first reply still goes out" }],
      },
    }]));

    await coordinator.waitForIdle("thread-outbound-drain");

    expect(enqueueDelivery).toHaveBeenCalledTimes(1);
    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-outbound-drain",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-main",
        externalConversationId: "chat-99",
        externalActorId: "user-99",
      },
      items: [{ type: "text", text: "first reply still goes out" }],
    }));

    const transcript = await store.loadTranscript("thread-outbound-drain");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:outbound",
      "telegram",
      "assistant",
      "runtime",
      "assistant",
    ]);
    expect(transcript[2]?.message).toMatchObject({
      role: "toolResult",
      toolName: "outbound",
      details: {
        ok: true,
        status: "queued",
        deliveryId: "delivery-1",
      },
    });
  });

  it("surfaces A2A wake inputs between turns without cancelling the current plan", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<{ done: string }>();
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_slow",
          name: "slow",
          arguments: { message: "first" },
        },
        {
          type: "toolCall",
          id: "call_echo",
          name: "echo",
          arguments: { message: "still drain this" },
        },
      ]),
      message("responded after the A2A ping"),
      message("Nothing else to do."),
    );

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("a2a-turn-boundary-agent", {
      agent: new Agent({
        name: "a2a-turn-boundary-agent",
        instructions: "Use tools when needed",
        tools: [new SlowTool(started, release), new EchoTool()],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-a2a-turn-boundary",
      agentKey: "a2a-turn-boundary-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-a2a-turn-boundary", {
      message: stringToUserMessage("start"),
      source: "tui",
    });

    await started.promise;

    await coordinator.submitInput("thread-a2a-turn-boundary", {
      message: stringToUserMessage("[A2A] ping from another Panda"),
      source: "a2a",
      channelId: "session-upstream",
      externalMessageId: "a2a:msg-1",
      actorId: "koala",
    });

    release.resolve({ done: "first" });
    await coordinator.waitForIdle("thread-a2a-turn-boundary");

    expect(runtime.complete).toHaveBeenCalledTimes(3);

    const transcript = await store.loadTranscript("thread-a2a-turn-boundary");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
      "tool:slow",
      "tool:echo",
      "a2a",
      "assistant",
      "runtime",
      "assistant",
    ]);
    expect(transcript[3]?.message).toMatchObject({
      role: "toolResult",
      toolName: "echo",
      details: {
        echoed: "still drain this",
      },
    });
  });

  it("applies a late input on the immediate next turn even if it lands after boundary polling starts", async () => {
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_echo",
          name: "echo",
          arguments: { message: "first" },
        },
      ]),
      message("saw the late ping right away"),
      message("unexpected third turn"),
    );

    let coordinator!: ThreadRuntimeCoordinator;
    let injected = false;
    class BoundaryRaceStore extends TestThreadRuntimeStore {
      override async hasRunnableInputs(threadId: string): Promise<boolean> {
        const base = await super.hasRunnableInputs(threadId);
        if (!injected && !base && runtime.complete.mock.calls.length === 1) {
          injected = true;
          queueMicrotask(() => {
            void coordinator.submitInput(threadId, {
              message: stringToUserMessage("late ping"),
              source: "telegram",
              channelId: "chat-race",
              externalMessageId: "late-1",
              actorId: "user-race",
            });
          });
        }

        return base;
      }
    }

    const store = new BoundaryRaceStore();
    const registry = new TestThreadDefinitionRegistry().register("boundary-race", {
      agent: new Agent({
        name: "boundary-race",
        instructions: "Use tools when needed",
        tools: [new EchoTool()],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-boundary-race",
      agentKey: "boundary-race",
    });

    coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-boundary-race", {
      message: stringToUserMessage("start"),
      source: "telegram",
      channelId: "chat-race",
      externalMessageId: "start-1",
      actorId: "user-race",
    });

    await coordinator.waitForIdle("thread-boundary-race");

    expect(runtime.complete).toHaveBeenCalledTimes(3);
    expect(runtime.complete.mock.calls[1]?.[0].context.messages.some((entry: { role: string; content: unknown }) => {
      return entry.role === "user" && entry.content === "late ping";
    })).toBe(true);

    const transcript = await store.loadTranscript("thread-boundary-race");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:echo",
      "telegram",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

  it("drains pending wakes when a fresh input also arrives at the boundary", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<{ done: string }>();
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_slow",
          name: "slow",
          arguments: { message: "first" },
        },
      ]),
      message("handled the late ping once"),
      message("unexpected empty wake turn"),
    );

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("wake-drain", {
      agent: new Agent({
        name: "wake-drain",
        instructions: "Use tools when needed",
        tools: [new SlowTool(started, release)],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-wake-drain",
      agentKey: "wake-drain",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-wake-drain", {
      message: stringToUserMessage("start"),
      source: "telegram",
      channelId: "chat-wake",
      externalMessageId: "start-1",
      actorId: "user-wake",
    });

    await started.promise;

    await coordinator.submitInput("thread-wake-drain", {
      message: stringToUserMessage("late ping"),
      source: "telegram",
      channelId: "chat-wake",
      externalMessageId: "late-1",
      actorId: "user-wake",
    });
    await coordinator.wake("thread-wake-drain");

    release.resolve({ done: "released" });
    await coordinator.waitForIdle("thread-wake-drain");

    expect(runtime.complete).toHaveBeenCalledTimes(3);

    const transcript = await store.loadTranscript("thread-wake-drain");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:slow",
      "telegram",
      "assistant",
      "runtime",
      "assistant",
    ]);
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "handled the late ping once");
    })).toBe(true);
  });

  it("rebuilds model context from the latest compact boundary plus later messages", async () => {
    const runtime = createMockRuntime(
      message("after compact"),
      message("Nothing else to do."),
    );
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("compact-agent", {
      agent: new Agent({
        name: "compact-agent",
        instructions: "Reply briefly",
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-compact-context",
      agentKey: "compact-agent",
    });

    await store.enqueueInput("thread-compact-context", {
      message: stringToUserMessage("old request"),
      source: "telegram",
    });
    await store.applyPendingInputs("thread-compact-context");
    await store.appendRuntimeMessage("thread-compact-context", {
      message: message("old reply"),
      source: "assistant",
    });
    await store.enqueueInput("thread-compact-context", {
      message: stringToUserMessage("recent request"),
      source: "telegram",
    });
    await store.applyPendingInputs("thread-compact-context");
    await store.appendRuntimeMessage("thread-compact-context", {
      message: message("recent reply"),
      source: "assistant",
    });
    await store.appendRuntimeMessage("thread-compact-context", {
      message: createCompactBoundaryMessage("Intent:\n- continue the recent work"),
      source: "compact",
      metadata: {
        kind: "compact_boundary",
        compactedUpToSequence: 2,
        preservedTailUserTurns: 3,
        trigger: "manual",
      },
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-compact-context", {
      message: stringToUserMessage("new request"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-compact-context");

    expect(runtime.complete).toHaveBeenCalledTimes(2);
    const request = runtime.complete.mock.calls[0]?.[0];
    const sentMessages = request?.context.messages;
    expect(sentMessages).toHaveLength(4);
    expect(sentMessages?.[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Conversation compacted"),
    });
    expect(sentMessages?.map((entry: { role: string; content?: unknown }) => {
      return entry.role === "user" && typeof entry.content === "string" ? entry.content : "";
    }).join("\n")).not.toContain("old request");
    expect(sentMessages?.map((entry: { role: string; content?: unknown }) => {
      return entry.role === "user" && typeof entry.content === "string" ? entry.content : "";
    }).join("\n")).toContain("recent request");
    expect(sentMessages?.map((entry: { role: string; content?: unknown }) => {
      return entry.role === "user" && typeof entry.content === "string" ? entry.content : "";
    }).join("\n")).toContain("new request");
  });

  it("does not auto-compact threads that are safely under budget", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      message("<summary>\nIntent:\n- should not run\n</summary>"),
    );
    const runtime = createMockRuntime(
      message("small thread reply"),
      message("Nothing else to do."),
    );
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("small-agent", {
      agent: new Agent({
        name: "small-agent",
        instructions: "Reply briefly",
      }),
      model: TEST_MODEL_WINDOW_1000,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-auto-compact-under",
      agentKey: "small-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-auto-compact-under", {
      message: stringToUserMessage("hello"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-auto-compact-under");

    expect(compactRuntime).not.toHaveBeenCalled();
    expect(runtime.complete).toHaveBeenCalledTimes(2);
  });

  it("auto-compacts risky threads before the model call", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      message("<summary>\nIntent:\n- continue the recent work\n</summary>"),
    );
    const runtime = createMockRuntime(
      message("after auto compact"),
      message("Nothing else to do."),
    );
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("auto-compact-agent", {
      agent: new Agent({
        name: "auto-compact-agent",
        instructions: "Reply briefly",
      }),
      model: TEST_MODEL_WINDOW_620,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-auto-compact",
      agentKey: "auto-compact-agent",
    });
    await seedAutoCompactionTranscript(store, "thread-auto-compact");

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-auto-compact", {
      message: stringToUserMessage("new request"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-auto-compact");

    expect(compactRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.complete).toHaveBeenCalledTimes(2);

    const request = runtime.complete.mock.calls[0]?.[0];
    const sentMessages = request?.context.messages;
    expect(sentMessages?.[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("Conversation compacted"),
    });
    const combinedUserText = sentMessages?.map((entry: { role: string; content?: unknown }) => {
      return entry.role === "user" && typeof entry.content === "string" ? entry.content : "";
    }).join("\n") ?? "";
    expect(combinedUserText).not.toContain("old request");
    expect(combinedUserText).toContain("keep one");
    expect(combinedUserText).toContain("new request");

    const transcript = await store.loadTranscript("thread-auto-compact");
    expect(transcript.some((entry) => entry.source === "compact")).toBe(true);
    expect(transcript.findLast((entry) => entry.source === "compact")?.metadata).toMatchObject({
      kind: "compact_boundary",
      trigger: "auto",
    });
  });

  it("records failure state and continues when auto-compaction fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      message(`<summary>\nIntent:\n- ${"x".repeat(8_000)}\n</summary>`),
    );
    const runtime = createMockRuntime(
      message("continued after compaction failure"),
      message("Nothing else to do."),
    );
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("auto-compact-fail-agent", {
      agent: new Agent({
        name: "auto-compact-fail-agent",
        instructions: "Reply briefly",
      }),
      model: TEST_MODEL_WINDOW_620,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-auto-compact-fail",
      agentKey: "auto-compact-fail-agent",
    });
    await seedAutoCompactionTranscript(store, "thread-auto-compact-fail");

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-auto-compact-fail", {
      message: stringToUserMessage("new request"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-auto-compact-fail");

    expect(compactRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.complete).toHaveBeenCalledTimes(2);

    const [run] = await store.listRuns("thread-auto-compact-fail");
    expect(run?.status).toBe("completed");
    expect(run?.error).toBeUndefined();

    const thread = await store.getThread("thread-auto-compact-fail");
    expect(thread.runtimeState?.autoCompaction).toMatchObject({
      consecutiveFailures: 1,
      lastAttempt: expect.objectContaining({
        outcome: "summary_too_large",
        trigger: "auto",
        model: TEST_MODEL_WINDOW_620,
        summaryRecordCount: expect.any(Number),
        preservedTailRecordCount: expect.any(Number),
        compactionInputChars: expect.any(Number),
      }),
    });

    const transcript = await store.loadTranscript("thread-auto-compact-fail");
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "continued after compaction failure");
    })).toBe(true);
    const notice = transcript.find((entry) => {
      return entry.metadata && typeof entry.metadata === "object" && entry.metadata !== null
        && "kind" in entry.metadata && entry.metadata.kind === "compact_failure_notice";
    });
    expect(notice).toMatchObject({
      source: "compact",
      metadata: expect.objectContaining({
        kind: "compact_failure_notice",
        trigger: "auto",
        consecutiveFailures: 1,
        diagnostics: expect.objectContaining({
          outcome: "summary_too_large",
          rawTextChars: expect.any(Number),
          parsedSummaryChars: expect.any(Number),
        }),
      }),
      message: expect.objectContaining({
        role: "assistant",
      }),
    });
  });

  it("continues after auto-compaction failure and applies later wakes", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete")
      .mockResolvedValueOnce(message(`<summary>\nIntent:\n- ${"x".repeat(8_000)}\n</summary>`));
    const runtime = createMockRuntime(
      message("after failure"),
      message("Nothing else to do."),
      message("after later wake"),
      message("Nothing else to do."),
    );
    const store = new TestThreadRuntimeStore();
    let retryModel = TEST_MODEL_WINDOW_620;
    const registry = new TestThreadDefinitionRegistry().register("auto-compact-retry-agent", () => ({
      agent: new Agent({
        name: "auto-compact-retry-agent",
        instructions: "Reply briefly",
      }),
      model: retryModel,
      runtime,
    }));

    await createRuntimeThread(store, {
      id: "thread-auto-compact-retry",
      agentKey: "auto-compact-retry-agent",
    });
    await seedAutoCompactionTranscript(store, "thread-auto-compact-retry");

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-auto-compact-retry", {
      message: stringToUserMessage("first risky request"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-auto-compact-retry");

    await coordinator.submitInput("thread-auto-compact-retry", {
      message: stringToUserMessage("second risky request"),
      source: "telegram",
    });

    retryModel = TEST_MODEL_WINDOW_5000;
    await coordinator.waitForIdle("thread-auto-compact-retry");

    expect(compactRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.complete).toHaveBeenCalledTimes(4);

    const runs = await store.listRuns("thread-auto-compact-retry");
    expect(runs.map((run) => run.status)).toEqual(["completed", "completed"]);

    const transcript = await store.loadTranscript("thread-auto-compact-retry");
    expect(transcript.some((entry) => entry.origin === "input" && entry.source === "telegram")).toBe(true);
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "after later wake");
    })).toBe(true);
    expect(await store.hasRunnableInputs("thread-auto-compact-retry")).toBe(false);
  });

  it("opens a cooldown breaker after repeated auto-compaction failures and retries after cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T10:00:00.000Z"));
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      message(`<summary>\nIntent:\n- ${"x".repeat(8_000)}\n</summary>`),
    );
    const runtime = createMockRuntime(
      message("continued one"),
      message("continued two"),
      message("continued three"),
      message("continued four"),
    );
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("auto-compact-breaker-agent", {
      agent: new Agent({
        name: "auto-compact-breaker-agent",
        instructions: "Reply briefly",
      }),
      model: TEST_MODEL_WINDOW_350,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-auto-compact-breaker",
      agentKey: "auto-compact-breaker-agent",
    });
    await seedAutoCompactionTranscript(store, "thread-auto-compact-breaker");

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    const largeInput = (label: string) => stringToUserMessage(`${label} ` + "z".repeat(500));

    await coordinator.submitInput("thread-auto-compact-breaker", {
      message: largeInput("new request one"),
      source: "heartbeat",
    });
    await coordinator.waitForIdle("thread-auto-compact-breaker");
    let thread = await store.getThread("thread-auto-compact-breaker");
    expect(thread.runtimeState?.autoCompaction).toMatchObject({
      consecutiveFailures: 1,
      lastAttempt: expect.objectContaining({
        outcome: "summary_too_large",
      }),
    });

    await coordinator.submitInput("thread-auto-compact-breaker", {
      message: largeInput("new request two"),
      source: "heartbeat",
    });
    await coordinator.waitForIdle("thread-auto-compact-breaker");

    thread = await store.getThread("thread-auto-compact-breaker");
    expect(thread.runtimeState?.autoCompaction?.consecutiveFailures).toBe(2);
    expect(thread.runtimeState?.autoCompaction?.cooldownUntil).toBeGreaterThan(Date.now());
    let transcript = await store.loadTranscript("thread-auto-compact-breaker");
    const failureNoticesBeforeCooldown = transcript.filter((entry) => {
      return entry.metadata && typeof entry.metadata === "object" && entry.metadata !== null
        && "kind" in entry.metadata && entry.metadata.kind === "compact_failure_notice";
    });
    expect(failureNoticesBeforeCooldown).toHaveLength(2);
    const compactCallsBeforeCooldown = compactRuntime.mock.calls.length;
    const failureAtBeforeCooldown = thread.runtimeState?.autoCompaction?.lastFailureAt;

    await coordinator.submitInput("thread-auto-compact-breaker", {
      message: largeInput("new request three"),
      source: "heartbeat",
    });
    await coordinator.waitForIdle("thread-auto-compact-breaker");

    expect(compactRuntime).toHaveBeenCalledTimes(compactCallsBeforeCooldown);
    const runsBeforeCooldown = await store.listRuns("thread-auto-compact-breaker");
    expect(runsBeforeCooldown.at(-1)?.status).toBe("completed");
    expect(runsBeforeCooldown.at(-1)?.error).toBeUndefined();
    thread = await store.getThread("thread-auto-compact-breaker");
    expect(thread.runtimeState?.autoCompaction?.lastFailureAt).toBe(failureAtBeforeCooldown);
    transcript = await store.loadTranscript("thread-auto-compact-breaker");
    const failureNoticesDuringCooldown = transcript.filter((entry) => {
      return entry.metadata && typeof entry.metadata === "object" && entry.metadata !== null
        && "kind" in entry.metadata && entry.metadata.kind === "compact_failure_notice";
    });
    expect(failureNoticesDuringCooldown).toHaveLength(failureNoticesBeforeCooldown.length);

    vi.setSystemTime(Date.now() + AUTO_COMPACT_BREAKER_COOLDOWN_MS + 1);

    await coordinator.submitInput("thread-auto-compact-breaker", {
      message: largeInput("new request four"),
      source: "heartbeat",
    });
    await coordinator.waitForIdle("thread-auto-compact-breaker");

    thread = await store.getThread("thread-auto-compact-breaker");
    expect(thread.runtimeState?.autoCompaction).toMatchObject({
      consecutiveFailures: 1,
    });
    expect(thread.runtimeState?.autoCompaction?.lastFailureAt).toBeGreaterThan(failureAtBeforeCooldown ?? 0);
  });

  it("recovers only orphaned runs that are not currently leased", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, { id: "thread-free", agentKey: "panda" });
    await createRuntimeThread(store, { id: "thread-held", agentKey: "panda" });
    const freeRun = await store.createRun("thread-free");
    const heldRun = await store.createRun("thread-held");

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      resolveDefinition: async () => {
        throw new Error("Not used in this test");
      },
      leaseManager: new SelectiveLeaseManager(["thread-held"]),
    });

    const recovered = await coordinator.recoverOrphanedRuns("recover");

    expect(recovered.map((run) => run.id)).toEqual([freeRun.id]);
    expect((await store.getRun(freeRun.id)).status).toBe("failed");
    expect((await store.getRun(heldRun.id)).status).toBe("running");
  });

  it("can abort an active run from another coordinator instance", async () => {
    const started = createDeferred<void>();
    const release = createDeferred<{ done: string }>();
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "slow",
          arguments: { message: "first" },
        },
      ]),
    );

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("abort-agent", {
      agent: new Agent({
        name: "abort-agent",
        instructions: "Use tools when needed",
        tools: [new SlowTool(started, release)],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-abort",
      agentKey: "abort-agent",
    });

    const owner = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });
    const observer = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await owner.submitInput("thread-abort", {
      message: stringToUserMessage("start"),
      source: "telegram",
    });

    await started.promise;

    expect(await observer.abort("thread-abort", "Stop from observer")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release.resolve({ done: "late" });

    await waitFor(async () => (await store.getRun((await store.listRuns("thread-abort"))[0]!.id)).status === "failed");

    const [run] = await store.listRuns("thread-abort");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("Stop from observer");
  });

  it("restarts after a new wake arrives during run completion", async () => {
    const enteredCompleteRun = createDeferred<void>();
    const releaseCompleteRun = createDeferred<void>();
    const runtime = createMockRuntime(
      message("first"),
      message("Nothing else to do."),
      message("second"),
      message("Nothing else to do."),
    );

    const store = new CompleteRunBlockingStore(enteredCompleteRun, releaseCompleteRun);
    const registry = new TestThreadDefinitionRegistry().register("completion-race", {
      agent: new Agent({
        name: "completion-race",
        instructions: "Reply briefly",
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-completion-race",
      agentKey: "completion-race",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-completion-race", {
      message: stringToUserMessage("first input"),
      source: "telegram",
    });

    await enteredCompleteRun.promise;

    await coordinator.submitInput("thread-completion-race", {
      message: stringToUserMessage("second input"),
      source: "tui",
    });

    releaseCompleteRun.resolve();
    await coordinator.waitForIdle("thread-completion-race");

    expect(runtime.complete).toHaveBeenCalledTimes(4);
    const transcript = await store.loadTranscript("thread-completion-race");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "runtime",
      "assistant",
      "tui",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

  it("fails the run instead of hanging when a tool throws a plain error", async () => {
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_crash",
          name: "crash",
          arguments: {},
        },
      ]),
    );

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("crash-agent", {
      agent: new Agent({
        name: "crash-agent",
        instructions: "Use tools when needed",
        tools: [new CrashTool()],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-crash",
      agentKey: "crash-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-crash", {
      message: stringToUserMessage("start"),
      source: "telegram",
    });

    await expect(coordinator.waitForIdle("thread-crash")).rejects.toThrow("crash-tool boom");

    const [run] = await store.listRuns("thread-crash");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("crash-tool boom");
  });

  it("fails the run when the provider returns an error stop reason after a tool call", async () => {
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_echo",
          name: "echo",
          arguments: { message: "hi" },
        },
      ]),
      createAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Overloaded",
      }),
    );

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("provider-error-agent", {
      agent: new Agent({
        name: "provider-error-agent",
        instructions: "Use tools when needed",
        tools: [new EchoTool()],
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-provider-error",
      agentKey: "provider-error-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-provider-error", {
      message: stringToUserMessage("start"),
      source: "telegram",
    });

    await expect(coordinator.waitForIdle("thread-provider-error")).rejects.toThrow("Overloaded");

    const [run] = await store.listRuns("thread-provider-error");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("Overloaded");

    const transcript = await store.loadTranscript("thread-provider-error");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:echo",
    ]);
  });

  it("fails a timed out complete call without wedging the thread for later inputs", async () => {
    const runtime = new DeferredRuntime();
    runtime.queue(new Promise<AssistantMessage>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error("Provider request timed out after 20ms."));
      }, 20);
    }));
    runtime.queue(message("recovered reply"));
    runtime.queue(message("recovered extra pass"));

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("provider-timeout-agent", {
      agent: new Agent({
        name: "provider-timeout-agent",
        instructions: "Reply plainly.",
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-provider-timeout",
      agentKey: "provider-timeout-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
      leaseManager: new SelectiveLeaseManager(),
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-provider-timeout", {
      message: stringToUserMessage("first try"),
      source: "telegram",
    });

    await expect(coordinator.waitForIdle("thread-provider-timeout")).rejects.toThrow(
      "Provider request timed out after 20ms.",
    );

    let runs = await store.listRuns("thread-provider-timeout");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toContain("Provider request timed out after 20ms.");
    expect(await store.listRunningRuns()).toEqual([]);

    await coordinator.submitInput("thread-provider-timeout", {
      message: stringToUserMessage("second try"),
      source: "tui",
    });

    await coordinator.waitForIdle("thread-provider-timeout");

    runs = await store.listRuns("thread-provider-timeout");
    expect(runs).toHaveLength(2);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[1]?.status).toBe("completed");
    expect(runtime.complete).toHaveBeenCalledTimes(3);

    const transcript = await store.loadTranscript("thread-provider-timeout");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "tui",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });
});

describe("Thread runtime stores", () => {
  it("requires session-backed thread creation in the test store", async () => {
    const store = new TestThreadRuntimeStore();

    await expect(store.createThread({
      id: "missing-session-thread",
      context: {
        agentKey: "panda",
      },
    } as CreateThreadInput)).rejects.toThrow("Thread sessionId is required.");
  });

  it("dedupes retries per source and channel, not just external message id", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, { id: "identity", agentKey: "panda" });

    await store.enqueueInput("identity", {
      message: stringToUserMessage("hello"),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "message-1",
    });
    await store.enqueueInput("identity", {
      message: stringToUserMessage("duplicate"),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "message-1",
    });
    await store.enqueueInput("identity", {
      message: stringToUserMessage("other chat"),
      source: "telegram",
      channelId: "chat-2",
      externalMessageId: "message-1",
    });

    const pending = await store.listPendingInputs("identity");
    expect(pending).toHaveLength(2);
    expect(pending.map((input) => input.channelId)).toEqual([
      "chat-1",
      "chat-2",
    ]);
  });

  it("persists input metadata from pending inputs into the transcript", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, { id: "metadata-thread", agentKey: "panda" });

    await store.enqueueInput("metadata-thread", {
      message: stringToUserMessage("photo attached"),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "message-1",
      metadata: {
        media: [
          {
            id: "media-1",
            localPath: "/tmp/panda/photo.jpg",
          },
        ],
      },
    });

    await expect(store.listPendingInputs("metadata-thread")).resolves.toEqual([
      expect.objectContaining({
        metadata: {
          media: [
            {
              id: "media-1",
              localPath: "/tmp/panda/photo.jpg",
            },
          ],
        },
      }),
    ]);

    const applied = await store.applyPendingInputs("metadata-thread");
    expect(applied).toEqual([
      expect.objectContaining({
        metadata: {
          media: [
            {
              id: "media-1",
              localPath: "/tmp/panda/photo.jpg",
            },
          ],
        },
      }),
    ]);
    await expect(store.loadTranscript("metadata-thread")).resolves.toEqual([
      expect.objectContaining({
        metadata: {
          media: [
            {
              id: "media-1",
              localPath: "/tmp/panda/photo.jpg",
            },
          ],
        },
      }),
    ]);
  });

  it("summarizes threads without loading transcripts for each thread", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, { id: "summary-a", agentKey: "panda" });
    await createRuntimeThread(store, { id: "summary-b", agentKey: "panda" });

    await store.enqueueInput("summary-a", {
      message: stringToUserMessage("hello"),
      source: "telegram",
    });
    await store.applyPendingInputs("summary-a");
    await store.appendRuntimeMessage("summary-a", {
      message: message("reply"),
      source: "assistant",
    });

    await store.enqueueInput("summary-b", {
      message: stringToUserMessage("queued"),
      source: "tui",
    }, "queue");

    const summaries = await store.listThreadSummaries();
    const summaryA = summaries.find((summary) => summary.thread.id === "summary-a");
    const summaryB = summaries.find((summary) => summary.thread.id === "summary-b");

    expect(summaryA).toMatchObject({
      messageCount: 2,
      pendingInputCount: 0,
      lastMessage: {
        source: "assistant",
      } satisfies Partial<ThreadMessageRecord>,
    });
    expect(summaryB).toMatchObject({
      messageCount: 0,
      pendingInputCount: 1,
    });
  });
});

describe("Thread abort handling", () => {
  it("passes AbortSignal into runtime requests and tool contexts", async () => {
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_signal",
          name: "signal-aware",
          arguments: {},
        },
      ]),
      message("done"),
    );
    const controller = new AbortController();
    const thread = new Thread({
      agent: new Agent({
        name: "signal-agent",
        instructions: "Use the tool",
        tools: [new SignalAwareTool()],
      }),
      messages: [stringToUserMessage("check the signal")],
      runtime,
      signal: controller.signal,
    });

    const outputs = [];
    for await (const event of thread.run()) {
      outputs.push(event);
    }

    expect(runtime.complete).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
    }));
    expect(outputs[1]).toMatchObject({
      role: "toolResult",
      toolName: "signal-aware",
      details: {
        hasSignal: true,
      },
    });
  });

  it("stops before calling the model when the signal is already aborted", async () => {
    const runtime = createMockRuntime(message("should not run"));
    const controller = new AbortController();
    controller.abort(new Error("stop-now"));

    const thread = new Thread({
      agent: new Agent({
        name: "aborted-agent",
        instructions: "This should never run",
      }),
      messages: [stringToUserMessage("hello")],
      runtime,
      signal: controller.signal,
    });

    await expect(thread.runToCompletion()).rejects.toThrow("stop-now");
    expect(runtime.complete).not.toHaveBeenCalled();
  });
});
