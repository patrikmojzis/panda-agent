import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";
import {createAssistantMessageEventStream, type AssistantMessage} from "@earendil-works/pi-ai";
import {
    Agent,
    BackgroundJobStatusTool,
    BackgroundJobWaitTool,
    BashTool,
    type LlmRuntime,
    PiAiRuntime,
    RunContext,
    stringToUserMessage,
    Thread,
    Tool,
    z,
} from "../src/index.js";
import {ContextWindowExceededError} from "../src/kernel/agent/exceptions.js";
import {buildBackgroundToolThreadInput} from "../src/app/runtime/background-tool-thread-input.js";
import {
    AUTO_COMPACT_BREAKER_COOLDOWN_MS,
    createCompactBoundaryMessage,
    type CreateThreadInput,
    type ResolvedThreadDefinition,
    type ThreadDefinitionResolver,
    type ThreadMessageRecord,
    type ThreadRecord,
    type ThreadRunOwner,
    ThreadRuntimeCoordinator,
    type ThreadRuntimeCoordinatorOptions,
} from "../src/domain/threads/runtime/index.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";
import type {DefaultAgentSessionContext} from "../src/app/runtime/panda-session-context.js";
import {isRecord} from "../src/lib/records.js";

const TEST_MODELS = vi.hoisted(() => ({
  window350: "openai/panda-test-window-350",
  window620: "openai/panda-test-window-620",
  window750: "openai/panda-test-window-750",
  window1000: "openai/panda-test-window-1000",
  window5000: "openai/panda-test-window-5000",
  window6000: "openai/panda-test-window-6000",
  operatingWindowByModel: new Map<string, number>([
    ["openai/panda-test-window-350", 350],
    ["openai/panda-test-window-620", 620],
    ["openai/panda-test-window-750", 750],
    ["openai/panda-test-window-1000", 1_000],
    ["openai/panda-test-window-5000", 5_000],
    ["openai/panda-test-window-6000", 6_000],
  ]),
}));

const TEST_RUN_OWNER: ThreadRunOwner = {
  source: "panda-core",
  connectorKey: "test",
  holderId: "thread-runtime-test",
};
const activeTestCoordinators = new Set<ThreadRuntimeCoordinator>();

async function createTestCoordinator(
  options: Omit<ThreadRuntimeCoordinatorOptions, "maxConcurrentRuns">,
): Promise<ThreadRuntimeCoordinator> {
  const coordinator = new ThreadRuntimeCoordinator({
    ...options,
    maxConcurrentRuns: 1,
  });
  await coordinator.handleStoreNotificationStatus("listening");
  await coordinator.start(TEST_RUN_OWNER);
  activeTestCoordinators.add(coordinator);
  return coordinator;
}

async function startTestRun(store: TestThreadRuntimeStore, threadId: string) {
  await store.requestWake(threadId);
  const run = await store.tryStartRun(threadId, TEST_RUN_OWNER, randomUUID());
  if (!run) {
    throw new Error(`Could not start test run for ${threadId}.`);
  }
  return run;
}

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
const TEST_MODEL_WINDOW_750 = TEST_MODELS.window750;
const TEST_MODEL_WINDOW_1000 = TEST_MODELS.window1000;
const TEST_MODEL_WINDOW_5000 = TEST_MODELS.window5000;
const TEST_MODEL_WINDOW_6000 = TEST_MODELS.window6000;

const PROVIDER_CREDENTIAL_SENTINEL = "sk-retry247credential987654321";
const PROVIDER_REQUEST_ID_SENTINEL = "req-retry247request987654321";
const PROVIDER_PAYLOAD_SENTINEL = "RETRY247_PROVIDER_PAYLOAD_SENTINEL";

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

afterEach(async () => {
  await Promise.allSettled(
    [...activeTestCoordinators].map((coordinator) => coordinator.stop()),
  );
  activeTestCoordinators.clear();
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

function terminalAssistantError(errorMessage: string): Promise<AssistantMessage> {
  const response = createAssistantMessage([], {stopReason: "error", errorMessage});
  const stream = createAssistantMessageEventStream();
  stream.push({type: "error", reason: "error", error: response});
  return stream.result();
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

class CompletionReconciliationFailureStore extends CompleteRunBlockingStore {
  failNextExactRunnableRead = false;
  exactRunnableReads = 0;

  override async isThreadRunnable(threadId: string): Promise<boolean> {
    this.exactRunnableReads += 1;
    if (this.failNextExactRunnableRead) {
      this.failNextExactRunnableRead = false;
      throw new Error("transient exact runnable read failure");
    }
    return super.isThreadRunnable(threadId);
  }

}

class TransientRunnableReadFailureStore extends TestThreadRuntimeStore {
  failNextExactRunnableRead = false;
  exactRunnableReads = 0;

  override async isThreadRunnable(threadId: string): Promise<boolean> {
    this.exactRunnableReads += 1;
    if (this.failNextExactRunnableRead) {
      this.failNextExactRunnableRead = false;
      throw new Error("transient exact runnable read failure");
    }
    return super.isThreadRunnable(threadId);
  }
}

class AmbiguousTerminalStore extends TestThreadRuntimeStore {
  completeCalls = 0;
  failCalls = 0;
  failNextTerminalRead = false;

  override async completeRun(runId: string) {
    this.completeCalls += 1;
    const completed = await super.completeRun(runId);
    if (this.completeCalls === 1) {
      throw new Error("connection dropped after completion commit");
    }
    return completed;
  }

  override async failRun(runId: string, error?: string) {
    this.failCalls += 1;
    if (this.failCalls === 1) {
      this.failNextTerminalRead = true;
      throw new Error("connection dropped before failure commit");
    }
    return super.failRun(runId, error);
  }

  override async getRun(runId: string) {
    if (this.failNextTerminalRead) {
      this.failNextTerminalRead = false;
      throw new Error("database temporarily unavailable");
    }
    return super.getRun(runId);
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

class OutboundTestTool extends Tool<typeof OutboundTestTool.schema, DefaultAgentSessionContext> {
  static schema = z.object({
    items: z.array(z.object({
      type: z.literal("text"),
      text: z.string(),
    })),
  });

  name = "outbound";
  description = "Test outbound queue tool.";
  schema = OutboundTestTool.schema;

  async handle(args: z.output<typeof OutboundTestTool.schema>, run: RunContext<DefaultAgentSessionContext>) {
    const route = isRecord(run.context.currentRouteInput?.metadata)
      && isRecord(run.context.currentRouteInput.metadata.route)
      ? run.context.currentRouteInput.metadata.route
      : null;
    if (!route) {
      throw new Error("Missing route metadata.");
    }
    const target = {
      source: String(route.source),
      connectorKey: String(route.connectorKey),
      externalConversationId: String(route.externalConversationId),
      ...(typeof route.externalActorId === "string" ? {externalActorId: route.externalActorId} : {}),
    };
    const delivery = await run.context.outboundQueue?.enqueueDelivery({
      threadId: run.context.threadId,
      channel: target.source,
      target,
      items: args.items,
    });
    await run.context.routeMemory?.saveLastRoute({
      ...target,
      capturedAt: Date.now(),
    }, {
      ...(run.context.currentRouteInput?.identityId ? {identityId: run.context.currentRouteInput.identityId} : {}),
    });
    return {
      content: [{type: "text" as const, text: "queued"}],
      details: {
        ok: true,
        status: "queued",
        deliveryId: delivery?.id,
      },
    };
  }
}

class BlockedClaimStore extends TestThreadRuntimeStore {
  attempts = 0;

  override async tryStartRun(): Promise<null> {
    this.attempts += 1;
    return null;
  }

  override async isThreadRunnable(): Promise<boolean> {
    // Models a competing durable running row. The input is still pending, but
    // the exact claimability check must not spin while another owner runs it.
    return false;
  }
}

class LostClaimResponseStore extends TestThreadRuntimeStore {
  attempts = 0;
  readonly attemptedRunIds: string[] = [];

  override async tryStartRun(threadId: string, owner: ThreadRunOwner, runId: string) {
    this.attempts += 1;
    this.attemptedRunIds.push(runId);
    const run = await super.tryStartRun(threadId, owner, runId);
    if (this.attempts === 1 && run) {
      throw new Error("database connection reset after claim commit");
    }
    return run;
  }
}

class ShutdownLostClaimResponseStore extends TestThreadRuntimeStore {
  readonly claimCommitted = createDeferred<void>();
  readonly releaseClaimError = createDeferred<void>();
  readonly attemptedRunIds: string[] = [];

  override async tryStartRun(threadId: string, owner: ThreadRunOwner, runId: string) {
    this.attemptedRunIds.push(runId);
    const run = await super.tryStartRun(threadId, owner, runId);
    if (this.attemptedRunIds.length === 1 && run) {
      this.claimCommitted.resolve();
      await this.releaseClaimError.promise;
      throw new Error("database connection reset after claim commit");
    }
    return run;
  }
}

const testAgentKeyByThreadId = new Map<string, string>();

class TestThreadDefinitionRegistry {
  private readonly resolvers = new Map<string, ThreadDefinitionResolver>();

  register(agentKey: string, definition: ResolvedThreadDefinition | ThreadDefinitionResolver): this {
    this.resolvers.set(agentKey, typeof definition === "function" ? definition : async () => definition);
    return this;
  }

  resolve(thread: ThreadRecord): Promise<ResolvedThreadDefinition> {
    const agentKey = testAgentKeyByThreadId.get(thread.id) ?? "";
    const resolver = this.resolvers.get(agentKey);
    if (!resolver) {
      throw new Error(`No thread definition registered for agent key ${agentKey}.`);
    }

    return Promise.resolve(resolver(thread));
  }
}

async function createRuntimeThread(
  store: TestThreadRuntimeStore,
  input: Omit<CreateThreadInput, "sessionId"> & {
    agentKey: string;
    sessionId?: string;
  },
): Promise<ThreadRecord> {
  const {
    id,
    agentKey,
    sessionId = `${id}-session`,
    ...threadInput
  } = input;
  testAgentKeyByThreadId.set(id, agentKey);

  return store.createThread({
    id,
    sessionId,
    ...threadInput,
  });
}

async function seedAutoCompactionTranscript(store: TestThreadRuntimeStore, threadId: string): Promise<void> {
  const run = await startTestRun(store, threadId);
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("old request " + "a".repeat(2_400)),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId, run.id);
  await store.appendRuntimeMessage(threadId, {
    message: message("old reply"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep one"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId, run.id);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply one"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep two"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId, run.id);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply two"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep three"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId, run.id);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply three"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep four"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId, run.id);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply four"),
    source: "assistant",
  });
  await store.enqueueInput(threadId, {
    message: stringToUserMessage("keep five"),
    source: "telegram",
  });
  await store.applyPendingInputs(threadId, run.id);
  await store.appendRuntimeMessage(threadId, {
    message: message("reply five"),
    source: "assistant",
  });
  await store.completeRun(run.id);
}

describe("ThreadRuntimeCoordinator", () => {
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
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });
    await coordinator.submitInput("thread-input-message-context", {
      message: stringToUserMessage("capture this input"),
      source: "heartbeat",
      identityId: "identity-1",
    });
    await coordinator.waitForIdle("thread-input-message-context");

    const input = (await store.loadTranscriptHistory("thread-input-message-context"))
      .find((entry) => entry.origin === "input");
    const inputId = input?.id;
    expect(inputId).toEqual(expect.any(String));
    expect(capturedContext).toMatchObject({
      currentInput: {
        messageId: inputId,
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

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-idle-reroll");
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

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-heartbeat-no-reroll");
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

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-idle-reroll-reset");
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
      const firstRun = await startTestRun(store, "thread-bg-runtime");

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
        runId: firstRun.id,
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
      await store.completeRun(firstRun.id);

      const secondRun = await startTestRun(store, "thread-bg-runtime");
      const secondRunContext = {
        ...firstRunContext,
        runId: secondRun.id,
      };
      const completedLater = await status.run(
        { jobId },
        runContext(secondRunContext),
      );

      expect((completedLater as {status: string; stdout: string}).status).toBe("completed");
      expect((completedLater as {stdout: string}).stdout).toBe("hello");
      expect(await store.listToolJobs("thread-bg-runtime")).toHaveLength(1);
      expect((await store.getToolJob(jobId)).runId).toBe(firstRun.id);

      const orphan = await bash.run(
        { command: "sleep 10", background: true },
        runContext(secondRunContext),
      );
      const orphanJobId = String((orphan as {jobId: string}).jobId);

      expect(await store.markOrphanedToolJobsLost({
        source: "panda-core",
        connectorKey: "test",
        holderId: "replacement-runtime",
      }, "runtime restarted", 100)).toBe(1);

      const lost = await status.run(
        { jobId: orphanJobId },
        runContext(secondRunContext),
      );
      expect((lost as {status: string; reason?: string}).status).toBe("lost");
      expect((lost as {reason?: string}).reason).toBe("runtime restarted");
      await service.close();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("settles cooperative standalone background jobs before shutdown releases ownership", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-background-shutdown",
      agentKey: "panda",
    });
    const service = new BackgroundToolJobService({
      store,
      owner: TEST_RUN_OWNER,
      shutdownSettleTimeoutMs: 100,
    });
    const cancelled = vi.fn(() => ({
      status: "cancelled" as const,
      statusReason: "Runtime shutdown.",
    }));
    const never = createDeferred<void>();

    const record = await service.start({
      threadId: "thread-background-shutdown",
      kind: "web_research",
      summary: "long research",
      start: () => ({
        done: never.promise,
        cancel: cancelled,
      }),
    });

    await service.close();

    expect(cancelled).toHaveBeenCalledWith("Runtime shutdown.");
    await expect(store.getToolJob(record.id)).resolves.toMatchObject({
      owner: TEST_RUN_OWNER,
      status: "cancelled",
      statusReason: "Runtime shutdown.",
    });
  });

  it("cancels and settles background work that is still starting", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-background-starting-shutdown",
      agentKey: "panda",
    });
    const service = new BackgroundToolJobService({
      store,
      owner: TEST_RUN_OWNER,
      shutdownSettleTimeoutMs: 100,
    });
    const entered = createDeferred<void>();
    const starting = service.start({
      threadId: "thread-background-starting-shutdown",
      kind: "web_research",
      summary: "starting research",
      start: ({signal}) => new Promise((_, reject) => {
        entered.resolve();
        signal.addEventListener("abort", () => reject(signal.reason), {once: true});
      }),
    });
    await entered.promise;
    const rejectedStart = expect(starting).rejects.toThrow("Runtime shutdown.");

    await service.close();
    await rejectedStart;

    await expect(store.listToolJobs("thread-background-starting-shutdown")).resolves.toEqual([
      expect.objectContaining({status: "cancelled", statusReason: "Runtime shutdown."}),
    ]);
  });

  it("waits for a delayed startup handle and cancels it before shutdown completes", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-background-delayed-handle-shutdown",
      agentKey: "panda",
    });
    const service = new BackgroundToolJobService({
      store,
      owner: TEST_RUN_OWNER,
      shutdownSettleTimeoutMs: 250,
    });
    const entered = createDeferred<void>();
    const releaseHandle = createDeferred<void>();
    const cancelled = vi.fn(() => ({
      status: "cancelled" as const,
      statusReason: "Runtime shutdown.",
    }));
    const starting = service.start({
      threadId: "thread-background-delayed-handle-shutdown",
      kind: "web_research",
      summary: "delayed external handle",
      start: async () => {
        entered.resolve();
        await releaseHandle.promise;
        return {done: Promise.resolve(), cancel: cancelled};
      },
    });
    await entered.promise;

    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseHandle.resolve();
    await closing;
    await expect(starting).resolves.toMatchObject({
      status: "cancelled",
      statusReason: "Runtime shutdown.",
    });
    expect(cancelled).toHaveBeenCalledWith("Runtime shutdown.");
  });

  it("does not start external work when shutdown begins during durable job reservation", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-background-reservation-shutdown",
      agentKey: "panda",
    });
    const service = new BackgroundToolJobService({
      store,
      owner: TEST_RUN_OWNER,
      shutdownSettleTimeoutMs: 100,
    });
    const reservationEntered = createDeferred<void>();
    const releaseReservation = createDeferred<void>();
    const createToolJob = store.createToolJob.bind(store);
    vi.spyOn(store, "createToolJob").mockImplementation(async (input) => {
      reservationEntered.resolve();
      await releaseReservation.promise;
      return createToolJob(input);
    });
    const startExternalWork = vi.fn(() => ({done: Promise.resolve()}));

    const starting = service.start({
      threadId: "thread-background-reservation-shutdown",
      kind: "web_research",
      summary: "delayed reservation",
      start: startExternalWork,
    });
    await reservationEntered.promise;
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseReservation.resolve();
    await closing;
    await expect(starting).resolves.toMatchObject({
      status: "cancelled",
      statusReason: "Runtime shutdown.",
    });
    expect(startExternalWork).not.toHaveBeenCalled();
  });

  it("surfaces background wake inputs before the next model turn when watcher-owned background jobs finish during an active run", async () => {
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
          expect(request.context.messages.at(-1)?.role).not.toBe("assistant");

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

      const coordinator = await createTestCoordinator({
        store,
        resolveDefinition: (thread) => registry.resolve(thread),
      });
      service.setBackgroundCompletionHandler(async (record) => {
        await coordinator.submitInput(record.threadId, buildBackgroundToolThreadInput(record), "wake");
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
      expect(await store.hasPendingWake("thread-bg-autowake")).toBe(true);

      release.resolve({ done: "released" });
      await coordinator.waitForIdle("thread-bg-autowake");

      const transcript = await store.loadTranscriptHistory("thread-bg-autowake");
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

  it("preserves queued background input while another coordinator owns the durable run", async () => {
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
              message: "hold the run",
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
    const ownerCoordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });
    const otherCoordinator = await createTestCoordinator({
      store,
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
        kind: "bash",
        status: "completed",
        summary: "printf done",
        startedAt: Date.now() - 50,
        finishedAt: Date.now(),
        durationMs: 50,
      }),
      "queue",
    );
    await otherCoordinator.wake("thread-cross-process-wake");

    release.resolve({ done: "released" });
    await ownerCoordinator.waitForIdle("thread-cross-process-wake");

    expect(runtime.complete).toHaveBeenCalledTimes(3);
    const transcript = await store.loadTranscriptHistory("thread-cross-process-wake");
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
    );
    const registry = new TestThreadDefinitionRegistry().register("pending-wake-agent", {
      agent: new Agent({
        name: "pending-wake-agent",
        instructions: "React to runtime events.",
        tools: [],
      }),
      runtime,
    });
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await store.enqueueInput(
      "thread-pending-wake-idle",
      buildBackgroundToolThreadInput({
        id: "job-pending-wake-idle",
        threadId: "thread-pending-wake-idle",
        kind: "bash",
        status: "completed",
        summary: "printf done",
        startedAt: Date.now() - 25,
        finishedAt: Date.now(),
        durationMs: 25,
      }),
      "queue",
    );
    await store.requestWake("thread-pending-wake-idle");

    await coordinator.waitForIdle("thread-pending-wake-idle");

    expect(runtime.complete).toHaveBeenCalledTimes(2);
    const transcript = await store.loadTranscriptHistory("thread-pending-wake-idle");
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

  it("drains more than one page of queued inputs admitted by an explicit wake", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-paged-admission",
      agentKey: "paged-admission-agent",
    });
    const inputIds: string[] = [];
    for (let index = 0; index < 501; index += 1) {
      const enqueued = await store.enqueueInput("thread-paged-admission", {
        message: stringToUserMessage(`input ${index}`),
        source: "gateway",
      }, "queue");
      inputIds.push(enqueued.input.id);
    }
    await store.requestWake("thread-paged-admission");
    const runtime = createMockRuntime(
      message("processed first page"),
      message("processed final page"),
      message("Nothing else to do."),
    );
    const registry = new TestThreadDefinitionRegistry().register("paged-admission-agent", {
      agent: new Agent({
        name: "paged-admission-agent",
        instructions: "Process every admitted input.",
        tools: [],
      }),
      runtime,
    });
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.waitForIdle("thread-paged-admission");

    expect(runtime.complete).toHaveBeenCalledTimes(3);
    const inputs = await Promise.all(inputIds.map((inputId) => store.getInput(inputId)));
    expect(inputs).toHaveLength(501);
    expect(inputs.every((input) => input.status === "applied")).toBe(true);
  });

  it("re-arms an explicitly woken queue set when its run fails before applying", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-queued-fail-before-apply",
      agentKey: "queued-failure-agent",
    });
    const queued = await store.enqueueInput("thread-queued-fail-before-apply", {
      message: stringToUserMessage("queued work"),
      source: "gateway",
    }, "queue");
    await store.requestWake("thread-queued-fail-before-apply");

    const run = await store.tryStartRun("thread-queued-fail-before-apply", TEST_RUN_OWNER, randomUUID());
    expect(run).not.toBeNull();
    await expect(store.getInput(queued.input.id)).resolves.toMatchObject({
      deliveryMode: "queue",
    });
    expect(run!.admittedThroughInputOrder).toBeGreaterThanOrEqual(queued.input.order);

    await store.failRun(run!.id, "provider failed before apply");
    await expect(store.getInput(queued.input.id)).resolves.toMatchObject({
      deliveryMode: "queue",
    });
    await expect(store.hasPendingWake("thread-queued-fail-before-apply")).resolves.toBe(true);
  });

  it("admits the FIFO queue snapshot when a wake races an active run boundary", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-boundary-admission",
      agentKey: "boundary-admission-agent",
    });
    await store.enqueueInput("thread-boundary-admission", {
      message: stringToUserMessage("initial wake"),
      source: "gateway",
    });
    const run = await store.tryStartRun("thread-boundary-admission", TEST_RUN_OWNER, randomUUID());
    await store.applyPendingInputs("thread-boundary-admission", run!.id);

    const queuedBeforeWake = await store.enqueueInput("thread-boundary-admission", {
      message: stringToUserMessage("queued before wake"),
      source: "gateway",
    }, "queue");
    const wake = await store.enqueueInput("thread-boundary-admission", {
      message: stringToUserMessage("later wake"),
      source: "gateway",
    });
    const boundary = await store.takeRunBoundary("thread-boundary-admission", run!.id);
    expect(boundary).toEqual({
      hasAdmittedInputs: true,
      hadPendingWake: true,
    });
    const applied = await store.applyPendingInputs("thread-boundary-admission", run!.id);
    expect(applied.map((message) => message.inputId)).toEqual([
      queuedBeforeWake.input.id,
      wake.input.id,
    ]);
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
    const coordinator = await createTestCoordinator({
      store,
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
    const transcript = await store.loadTranscriptHistory("thread-external-poke");
    expect(transcript.some((entry) => entry.origin === "input" && entry.source === "gateway")).toBe(true);
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "processed external wake");
    })).toBe(true);
  });

  it("recovers a durable wake when the committed run-claim response is lost", async () => {
    const store = new LostClaimResponseStore();
    const runtime = createMockRuntime(
      message("processed after retry"),
      message("Nothing else to do."),
    );
    const registry = new TestThreadDefinitionRegistry().register("admission-retry-agent", {
      agent: new Agent({
        name: "admission-retry-agent",
        instructions: "Reply briefly.",
      }),
      runtime,
    });
    await createRuntimeThread(store, {
      id: "thread-admission-retry",
      agentKey: "admission-retry-agent",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-admission-retry", {
      message: stringToUserMessage("one durable wake"),
      source: "gateway",
    });
    await coordinator.waitForIdle("thread-admission-retry");

    expect(store.attempts).toBe(2);
    expect(new Set(store.attemptedRunIds).size).toBe(1);
    expect(runtime.complete).toHaveBeenCalledTimes(2);
    const runs = await store.listRuns("thread-admission-retry");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    const transcript = await store.loadTranscriptHistory("thread-admission-retry");
    expect(transcript.filter((entry) => entry.origin === "input")).toHaveLength(1);
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "processed after retry");
    })).toBe(true);
  });

  it("fails and rearms an ambiguously committed claim before shutdown releases ownership", async () => {
    const store = new ShutdownLostClaimResponseStore();
    await createRuntimeThread(store, {
      id: "thread-admission-shutdown",
      agentKey: "admission-shutdown-agent",
    });
    const coordinator = await createTestCoordinator({
      store,
      shutdownDrainTimeoutMs: 1_000,
      resolveDefinition: async () => {
        throw new Error("shutdown admission reconciliation must not start model work");
      },
    });

    await coordinator.submitInput("thread-admission-shutdown", {
      message: stringToUserMessage("survive shutdown"),
      source: "gateway",
    });
    await store.claimCommitted.promise;

    const stopping = coordinator.stop(new Error("planned shutdown"));
    const concurrentStop = coordinator.stop(new Error("later shutdown"));
    expect(concurrentStop).toBe(stopping);
    store.releaseClaimError.resolve();
    await Promise.all([stopping, concurrentStop]);

    expect(new Set(store.attemptedRunIds).size).toBe(1);
    const runs = await store.listRuns("thread-admission-shutdown");
    expect(runs).toEqual([
      expect.objectContaining({
        id: store.attemptedRunIds[0],
        status: "failed",
        error: "planned shutdown",
      }),
    ]);
    await expect(store.hasPendingWake("thread-admission-shutdown")).resolves.toBe(true);
    await expect(store.hasPendingInputs("thread-admission-shutdown")).resolves.toBe(true);
  });

  it("atomically restores a wake-only claim when shutdown wins before execution", async () => {
    const store = new ShutdownLostClaimResponseStore();
    await createRuntimeThread(store, {
      id: "thread-wake-only-admission-shutdown",
      agentKey: "wake-only-admission-shutdown-agent",
    });
    const coordinator = await createTestCoordinator({
      store,
      shutdownDrainTimeoutMs: 1_000,
      resolveDefinition: async () => {
        throw new Error("wake-only shutdown reconciliation must not start model work");
      },
    });

    await store.requestWake("thread-wake-only-admission-shutdown");
    await coordinator.poke("thread-wake-only-admission-shutdown");
    await store.claimCommitted.promise;

    const stopping = coordinator.stop(new Error("planned shutdown"));
    store.releaseClaimError.resolve();
    await stopping;

    const runs = await store.listRuns("thread-wake-only-admission-shutdown");
    expect(runs).toEqual([
      expect.objectContaining({
        id: store.attemptedRunIds[0],
        status: "failed",
        error: "planned shutdown",
      }),
    ]);
    await expect(store.hasPendingInputs("thread-wake-only-admission-shutdown")).resolves.toBe(false);
    await expect(store.hasPendingWake("thread-wake-only-admission-shutdown")).resolves.toBe(true);
  });

  it("leaves durable wake input pending when the database run claim is unavailable", async () => {
    const store = new BlockedClaimStore();
    await createRuntimeThread(store, {
      id: "thread-poke-held-lease",
      agentKey: "held-lease-agent",
    });
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: async () => {
        throw new Error("resolveDefinition should not be called without a run claim");
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

    await coordinator.waitForCurrentRun("thread-poke-held-lease");
    expect(store.attempts).toBeLessThanOrEqual(2);
    expect(await store.hasPendingWake("thread-poke-held-lease")).toBe(true);
  });

  it("treats pending durable wakes as busy", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "thread-pending-wake-busy",
      agentKey: "busy-agent",
    });

    const coordinator = await createTestCoordinator({
      store,
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

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-queued");
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

    const coordinator = await createTestCoordinator({
      store,
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
    expect(await store.hasPendingWake("thread-queued-during-run")).toBe(false);

    let transcript = await store.loadTranscriptHistory("thread-queued-during-run");
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
    transcript = await store.loadTranscriptHistory("thread-queued-during-run");
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

  it("restarts wake inputs that arrive during exclusive work once the lane is released", async () => {
    const runtime = createMockRuntime(
      message("processed after exclusive work"),
      message("Nothing else to do."),
    );
    const store = new TransientRunnableReadFailureStore();
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

    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });
    store.failNextExactRunnableRead = true;

    await coordinator.runExclusively("thread-exclusive", async () => {
      await coordinator.submitInput("thread-exclusive", {
        message: stringToUserMessage("hello after compact"),
        source: "tui",
      });

      expect(runtime.complete).toHaveBeenCalledTimes(0);
      expect(await store.hasPendingWake("thread-exclusive")).toBe(true);
    });

    await coordinator.waitForIdle("thread-exclusive");

    expect(store.exactRunnableReads).toBeGreaterThanOrEqual(2);
    expect(runtime.complete).toHaveBeenCalledTimes(2);
    expect((await store.loadTranscriptHistory("thread-exclusive")).map((entry) => entry.source)).toEqual([
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

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-replan");
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

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-after-assistant");
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
        tools: [new OutboundTestTool()],
      }),
      runtime,
      context: {
        agentKey: "outbound-agent",
        sessionId: "thread-outbound-drain-session",
        threadId: "thread-outbound-drain",
        outboundQueue: {
          enqueueDelivery,
        },
      },
    });

    await createRuntimeThread(store, {
      id: "thread-outbound-drain",
      agentKey: "outbound-agent",
      sessionId: "thread-outbound-drain-session",
      context: {
        agentKey: "outbound-agent",
        sessionId: "thread-outbound-drain-session",
        threadId: "thread-outbound-drain",
      },
    });

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-outbound-drain");
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

  it("routes background continuation outbound through the latest routed input", async () => {
    const runtime = createMockRuntime(
      message("handled initial telegram"),
      message("Nothing else to do."),
      createAssistantMessage([{
        type: "toolCall",
        id: "call_outbound",
        name: "outbound",
        arguments: {
          items: [{ type: "text", text: "background result" }],
        },
      }]),
      message("queued background result"),
      message("Nothing else to do."),
    );
    const enqueueDelivery = vi.fn(async (input) => ({
      id: "delivery-1",
      ...input,
      status: "pending" as const,
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const getLastRoute = vi.fn(async () => ({
      source: "telegram",
      connectorKey: "bot-stale",
      externalConversationId: "chat-stale",
      externalActorId: "user-stale",
      capturedAt: 123,
    }));
    const saveLastRoute = vi.fn(async () => {});

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("background-outbound-agent", {
      agent: new Agent({
        name: "background-outbound-agent",
        instructions: "Send the background result.",
        tools: [new OutboundTestTool()],
      }),
      runtime,
      context: {
        agentKey: "background-outbound-agent",
        sessionId: "thread-background-outbound-session",
        threadId: "thread-background-outbound",
        outboundQueue: {
          enqueueDelivery,
        },
        routeMemory: {
          getLastRoute,
          saveLastRoute,
        },
      },
    });

    await createRuntimeThread(store, {
      id: "thread-background-outbound",
      agentKey: "background-outbound-agent",
      sessionId: "thread-background-outbound-session",
    });
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-background-outbound", {
      message: stringToUserMessage("run a background job"),
      source: "telegram",
      channelId: "chat-99",
      externalMessageId: "msg-1",
      actorId: "user-99",
      identityId: "identity-patrik",
      metadata: {
        route: {
          source: "telegram",
          connectorKey: "bot-main",
          externalConversationId: "chat-99",
          externalActorId: "user-99",
        },
      },
    });
    await coordinator.waitForIdle("thread-background-outbound");

    await coordinator.submitInput("thread-background-outbound", buildBackgroundToolThreadInput({
      id: "job-background-outbound",
      threadId: "thread-background-outbound",
      kind: "bash",
      status: "completed",
      summary: "printf done",
      startedAt: Date.now() - 50,
      finishedAt: Date.now(),
      durationMs: 50,
    }));
    await coordinator.waitForIdle("thread-background-outbound");

    expect(getLastRoute).not.toHaveBeenCalled();
    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-background-outbound",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-main",
        externalConversationId: "chat-99",
        externalActorId: "user-99",
      },
      items: [{ type: "text", text: "background result" }],
    }));
    expect(saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-99",
      externalActorId: "user-99",
    }), {identityId: "identity-patrik"});

    const transcript = await store.loadTranscriptHistory("thread-background-outbound");
    const outboundResult = transcript.find((entry) => entry.source === "tool:outbound")?.message;
    expect(JSON.stringify(outboundResult)).not.toContain("bot-main");
    expect(JSON.stringify(outboundResult)).not.toContain("chat-99");
    expect(JSON.stringify(outboundResult)).not.toContain("user-99");
  });

  it("routes projected idle-reroll outbound through the latest routed input", async () => {
    const runtime = createMockRuntime(
      message("handled initial telegram"),
      createAssistantMessage([{
        type: "toolCall",
        id: "call_outbound_projected",
        name: "outbound",
        arguments: {
          items: [{ type: "text", text: "projected idle reroll result" }],
        },
      }]),
      message("queued projected idle reroll result"),
    );
    const enqueueDelivery = vi.fn(async (input) => ({
      id: "delivery-projected",
      ...input,
      status: "pending" as const,
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const getLastRoute = vi.fn(async () => ({
      source: "telegram",
      connectorKey: "bot-stale",
      externalConversationId: "chat-stale",
      externalActorId: "user-stale",
      capturedAt: 123,
    }));
    const saveLastRoute = vi.fn(async () => {});

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("projected-idle-outbound-agent", {
      agent: new Agent({
        name: "projected-idle-outbound-agent",
        instructions: "Send the idle reroll result.",
        tools: [new OutboundTestTool()],
      }),
      runtime,
      inferenceProjection: {
        dropMessages: {
          preserveTailMessages: 1,
        },
      },
      context: {
        agentKey: "projected-idle-outbound-agent",
        sessionId: "thread-projected-idle-outbound-session",
        threadId: "thread-projected-idle-outbound",
        outboundQueue: {
          enqueueDelivery,
        },
        routeMemory: {
          getLastRoute,
          saveLastRoute,
        },
      },
    });

    await createRuntimeThread(store, {
      id: "thread-projected-idle-outbound",
      agentKey: "projected-idle-outbound-agent",
      sessionId: "thread-projected-idle-outbound-session",
    });
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-projected-idle-outbound", {
      message: stringToUserMessage("use the idle reroll to reply"),
      source: "telegram",
      channelId: "chat-99",
      externalMessageId: "msg-1",
      actorId: "user-99",
      identityId: "identity-patrik",
      metadata: {
        route: {
          source: "telegram",
          connectorKey: "bot-main",
          externalConversationId: "chat-99",
          externalActorId: "user-99",
        },
      },
    });
    await coordinator.waitForIdle("thread-projected-idle-outbound");

    expect(getLastRoute).not.toHaveBeenCalled();
    expect(enqueueDelivery).toHaveBeenCalledWith(expect.objectContaining({
      threadId: "thread-projected-idle-outbound",
      channel: "telegram",
      target: {
        source: "telegram",
        connectorKey: "bot-main",
        externalConversationId: "chat-99",
        externalActorId: "user-99",
      },
      items: [{ type: "text", text: "projected idle reroll result" }],
    }));
    expect(saveLastRoute).toHaveBeenCalledWith(expect.objectContaining({
      source: "telegram",
      connectorKey: "bot-main",
      externalConversationId: "chat-99",
      externalActorId: "user-99",
    }), {identityId: "identity-patrik"});
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

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-a2a-turn-boundary");
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
      override async takeRunBoundary(threadId: string, runId: string) {
        const boundary = await super.takeRunBoundary(threadId, runId);
        if (!injected && runtime.complete.mock.calls.length === 1) {
          injected = true;
          await coordinator.submitInput(threadId, {
            message: stringToUserMessage("late ping"),
            source: "telegram",
            channelId: "chat-race",
            externalMessageId: "late-1",
            actorId: "user-race",
          });
        }

        return boundary;
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

    coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-boundary-race");
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

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-wake-drain");
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
    const seedRun = await startTestRun(store, "thread-compact-context");
    await store.applyPendingInputs("thread-compact-context", seedRun.id);
    await store.appendRuntimeMessage("thread-compact-context", {
      message: message("old reply"),
      source: "assistant",
    });
    await store.enqueueInput("thread-compact-context", {
      message: stringToUserMessage("recent request"),
      source: "telegram",
    });
    await store.applyPendingInputs("thread-compact-context", seedRun.id);
    await store.appendRuntimeMessage("thread-compact-context", {
      message: message("recent reply"),
      source: "assistant",
    });
    await store.commitCompaction("thread-compact-context", {
      expectedCheckpointId: null,
      message: createCompactBoundaryMessage("Intent:\n- continue the recent work"),
      metadata: {
        kind: "compact_boundary",
        compactedThroughSequence: 2,
        preservedTailUserTurns: 3,
        trigger: "manual",
      },
      runId: seedRun.id,
    });
    await store.completeRun(seedRun.id);

    const coordinator = await createTestCoordinator({
      store,
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

    const coordinator = await createTestCoordinator({
      store,
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

    const coordinator = await createTestCoordinator({
      store,
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

    const transcript = await store.loadTranscriptHistory("thread-auto-compact");
    expect(transcript.some((entry) => entry.source === "compact")).toBe(true);
    expect(transcript.findLast((entry) => entry.source === "compact")?.metadata).toMatchObject({
      kind: "compact_boundary",
      trigger: "auto",
    });
  });

  it("compacts and retries once after an exact provider context overflow", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      message("<summary>\nIntent:\n- continue after overflow\n</summary>"),
    );
    const overflow = createAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Your input exceeds the context window of this model. Please adjust your input and try again.",
    });
    const runtime = createMockRuntime(
      overflow,
      message("recovered after overflow"),
      message("Nothing else to do."),
    );
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("overflow-recovery-agent", {
      agent: new Agent({name: "overflow-recovery-agent", instructions: "Reply briefly"}),
      model: TEST_MODEL_WINDOW_5000,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-overflow-recovery",
      agentKey: "overflow-recovery-agent",
    });
    await seedAutoCompactionTranscript(store, "thread-overflow-recovery");

    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-overflow-recovery", {
      message: stringToUserMessage("new request"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-overflow-recovery");

    expect(compactRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.complete).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(runtime.complete.mock.calls[0]?.[0].context.messages)).toContain("old request");
    expect(JSON.stringify(runtime.complete.mock.calls[1]?.[0].context.messages)).not.toContain("old request");
    expect(JSON.stringify(runtime.complete.mock.calls[1]?.[0].context.messages)).toContain("new request");

    const [run] = await store.listRuns("thread-overflow-recovery");
    expect(run).toMatchObject({status: "completed", error: undefined});
    const transcript = await store.loadTranscriptHistory("thread-overflow-recovery");
    expect(transcript.findLast((entry) => entry.source === "compact")?.metadata).toMatchObject({
      kind: "compact_boundary",
      trigger: "auto",
    });
  });

  it("does not compact or retry twice when the rebuilt request still overflows", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      message("<summary>\nIntent:\n- continue after overflow\n</summary>"),
    );
    const overflow = createAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Your input exceeds the context window of this model. Please adjust your input and try again.",
    });
    const runtime = createMockRuntime(overflow, overflow);
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("repeated-overflow-agent", {
      agent: new Agent({name: "repeated-overflow-agent", instructions: "Reply briefly"}),
      model: TEST_MODEL_WINDOW_5000,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-repeated-overflow",
      agentKey: "repeated-overflow-agent",
    });
    await seedAutoCompactionTranscript(store, "thread-repeated-overflow");

    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-repeated-overflow", {
      message: stringToUserMessage("new request"),
      source: "tui",
    });
    await expect(coordinator.waitForIdle("thread-repeated-overflow")).rejects.toMatchObject({
      failureKind: "provider_context_overflow",
    });

    expect(compactRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.complete).toHaveBeenCalledTimes(2);
    const run = (await store.listRuns("thread-repeated-overflow")).at(-1);
    expect(run?.status).toBe("failed");
  });

  it("does not retry an unchanged request when overflow compaction cannot split the transcript", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      message("<summary>should not run</summary>"),
    );
    const overflow = createAssistantMessage([], {
      stopReason: "error",
      errorMessage: "Your input exceeds the context window of this model. Please adjust your input and try again.",
    });
    const runtime = createMockRuntime(overflow);
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("overflow-nosplit-agent", {
      agent: new Agent({name: "overflow-nosplit-agent", instructions: "Reply briefly"}),
      model: TEST_MODEL_WINDOW_5000,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-overflow-nosplit",
      agentKey: "overflow-nosplit-agent",
    });

    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-overflow-nosplit", {
      message: stringToUserMessage("single request"),
      source: "tui",
    });
    await expect(coordinator.waitForIdle("thread-overflow-nosplit")).rejects.toMatchObject({
      failureKind: "provider_context_overflow",
    });

    expect(compactRuntime).not.toHaveBeenCalled();
    expect(runtime.complete).toHaveBeenCalledTimes(1);
    const thread = await store.getThread("thread-overflow-nosplit");
    expect(thread.runtimeState?.autoCompaction).toMatchObject({
      consecutiveFailures: 1,
      lastAttempt: expect.objectContaining({outcome: "no_split", trigger: "auto"}),
    });
  });

  it("continues after auto-compaction failure when over trigger but under hard window", async () => {
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
      model: TEST_MODEL_WINDOW_750,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-auto-compact-fail",
      agentKey: "auto-compact-fail-agent",
    });
    await seedAutoCompactionTranscript(store, "thread-auto-compact-fail");

    const coordinator = await createTestCoordinator({
      store,
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
        model: TEST_MODEL_WINDOW_750,
        summaryRecordCount: expect.any(Number),
        preservedTailRecordCount: expect.any(Number),
        compactionInputChars: expect.any(Number),
      }),
    });

    const transcript = await store.loadTranscriptHistory("thread-auto-compact-fail");
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

  it("blocks provider calls when auto-compaction no_split leaves the active transcript over the hard window", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      message("<summary>should not run</summary>"),
    );
    const runtime = createMockRuntime(message("should not run"));
    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("auto-compact-nosplit-agent", {
      agent: new Agent({
        name: "auto-compact-nosplit-agent",
        instructions: "Reply briefly",
      }),
      model: TEST_MODEL_WINDOW_620,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-auto-compact-nosplit",
      agentKey: "auto-compact-nosplit-agent",
    });
    await store.enqueueInput("thread-auto-compact-nosplit", {
      message: stringToUserMessage("single oversized request " + "x".repeat(3_000)),
      source: "telegram",
    });
    const seedRun = await startTestRun(store, "thread-auto-compact-nosplit");
    await store.applyPendingInputs("thread-auto-compact-nosplit", seedRun.id);
    await store.completeRun(seedRun.id);

    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-auto-compact-nosplit", {
      message: stringToUserMessage("new request"),
      source: "tui",
    });
    await expect(coordinator.waitForIdle("thread-auto-compact-nosplit")).rejects.toThrow(ContextWindowExceededError);

    expect(compactRuntime).not.toHaveBeenCalled();
    expect(runtime.complete).not.toHaveBeenCalled();

    const run = (await store.listRuns("thread-auto-compact-nosplit")).at(-1);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("Active transcript exceeds the model context window");
    expect(run?.error).toContain("Start a fresh thread");
    expect(run?.error).not.toContain("single oversized request");

    const thread = await store.getThread("thread-auto-compact-nosplit");
    expect(thread.runtimeState?.autoCompaction).toMatchObject({
      consecutiveFailures: 1,
      lastAttempt: expect.objectContaining({
        outcome: "no_split",
        trigger: "auto",
        model: TEST_MODEL_WINDOW_620,
      }),
    });

    const transcript = await store.loadTranscriptHistory("thread-auto-compact-nosplit");
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
          outcome: "no_split",
        }),
      }),
    });
    expect(notice?.message.content.some((block) => {
      return block.type === "text" && block.text.includes("run blocked");
    })).toBe(true);
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
    let retryModel = TEST_MODEL_WINDOW_750;
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

    const coordinator = await createTestCoordinator({
      store,
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
    expect(runs.slice(1).map((run) => run.status)).toEqual(["completed", "completed"]);

    const transcript = await store.loadTranscriptHistory("thread-auto-compact-retry");
    expect(transcript.some((entry) => entry.origin === "input" && entry.source === "telegram")).toBe(true);
    expect(transcript.some((entry) => {
      return entry.message.role === "assistant"
        && entry.message.content.some((block) => block.type === "text" && block.text === "after later wake");
    })).toBe(true);
    expect(await store.hasPendingWake("thread-auto-compact-retry")).toBe(false);
  });

  it("opens a cooldown breaker after repeated auto-compaction failures and retries after cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T10:00:00.000Z"));
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const compactRuntime = vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      message(`<summary>\nIntent:\n- ${"x".repeat(30_000)}\n</summary>`),
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
      model: TEST_MODEL_WINDOW_6000,
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-auto-compact-breaker",
      agentKey: "auto-compact-breaker-agent",
    });
    await seedAutoCompactionTranscript(store, "thread-auto-compact-breaker");
    await store.enqueueInput("thread-auto-compact-breaker", {
      message: stringToUserMessage("extra old context " + "q".repeat(18_000)),
      source: "telegram",
    });
    const seedRun = await startTestRun(store, "thread-auto-compact-breaker");
    await store.applyPendingInputs("thread-auto-compact-breaker", seedRun.id);
    await store.completeRun(seedRun.id);

    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    const largeInput = (label: string) => stringToUserMessage(`${label} ` + "z".repeat(100));

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
    let transcript = await store.loadTranscriptHistory("thread-auto-compact-breaker");
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
    transcript = await store.loadTranscriptHistory("thread-auto-compact-breaker");
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

  it("recovers only runs whose durable daemon owner is no longer current", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, { id: "thread-free", agentKey: "panda" });
    await createRuntimeThread(store, { id: "thread-held", agentKey: "panda" });
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: async () => {
        throw new Error("Not used in this test");
      },
    });
    const freeRun = await store.createRun("thread-free");
    await store.requestWake("thread-held");
    const heldRun = await store.tryStartRun("thread-held", TEST_RUN_OWNER, randomUUID());
    if (!heldRun) {
      throw new Error("Expected a run owned by the current daemon.");
    }

    const recovered = await coordinator.recoverOrphanedRuns("recover");

    expect(recovered.map((run) => run.id)).toEqual([freeRun.id]);
    expect((await store.getRun(freeRun.id)).status).toBe("failed");
    expect((await store.getRun(freeRun.id)).error).toBe("recover");
    expect((await store.getRun(heldRun.id)).status).toBe("running");
  });

  it("records diagnostic context when recovering orphaned runs without an explicit reason", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T01:10:00.000Z"));

    try {
      const store = new TestThreadRuntimeStore();
      await createRuntimeThread(store, { id: "thread-free-default", agentKey: "panda" });
      await createRuntimeThread(store, { id: "thread-held-default", agentKey: "panda" });
      const coordinator = await createTestCoordinator({
        store,
        resolveDefinition: async () => {
          throw new Error("Not used in this test");
        },
      });
      const freeRun = await store.createRun("thread-free-default");
      await store.requestWake("thread-held-default");
      const heldRun = await store.tryStartRun("thread-held-default", TEST_RUN_OWNER, randomUUID());
      if (!heldRun) {
        throw new Error("Expected a run owned by the current daemon.");
      }

      const recovered = await coordinator.recoverOrphanedRuns();

      expect(recovered.map((run) => run.id)).toEqual([freeRun.id]);
      expect((await store.getRun(freeRun.id)).error).toBe(
        "Run marked failed during orphaned-run recovery; recoveryTrigger=coordinator_call; recoveryMechanism=daemon_lease_fenced_run_claim_sweep; probableCause=unknown; recoveredAt=2026-05-20T01:10:00.000Z.",
      );
      expect((await store.getRun(heldRun.id)).status).toBe("running");
      expect((await store.getRun(heldRun.id)).error).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

    const owner = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });
    const observer = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await owner.submitInput("thread-abort", {
      message: stringToUserMessage("start"),
      source: "telegram",
    });

    await started.promise;

    const [activeRun] = await store.listRuns("thread-abort");
    expect(activeRun).toBeDefined();
    expect(await observer.abort("thread-abort", "Stop from observer")).toBe(true);
    await owner.handleStoreNotification({
      kind: "run_abort_requested",
      threadId: "thread-abort",
      runId: activeRun!.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    release.resolve({ done: "late" });

    await waitFor(async () => (await store.getRun((await store.listRuns("thread-abort"))[0]!.id)).status === "failed");

    const [run] = await store.listRuns("thread-abort");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("Stop from observer");
    await Promise.all([owner.stop(), observer.stop()]);
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

    const coordinator = await createTestCoordinator({
      store,
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
    const transcript = await store.loadTranscriptHistory("thread-completion-race");
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

  it("reconciles final-boundary work when a run-finished observer fails", async () => {
    const enteredCompleteRun = createDeferred<void>();
    const releaseCompleteRun = createDeferred<void>();
    const runtime = createMockRuntime(
      message("first"),
      message("Nothing else to do."),
      message("second"),
      message("Nothing else to do."),
    );
    const store = new CompleteRunBlockingStore(enteredCompleteRun, releaseCompleteRun);
    const registry = new TestThreadDefinitionRegistry().register("finish-observer-race", {
      agent: new Agent({
        name: "finish-observer-race",
        instructions: "Reply briefly",
      }),
      runtime,
    });
    await createRuntimeThread(store, {
      id: "thread-finish-observer-race",
      agentKey: "finish-observer-race",
    });
    let finishEvents = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
      onEvent(event) {
        if (event.type === "run_finished") {
          finishEvents += 1;
          throw new Error("run-finished observer failed");
        }
      },
    });

    await coordinator.submitInput("thread-finish-observer-race", {
      message: stringToUserMessage("first input"),
      source: "telegram",
    });
    await enteredCompleteRun.promise;
    await coordinator.submitInput("thread-finish-observer-race", {
      message: stringToUserMessage("second input"),
      source: "tui",
    });

    releaseCompleteRun.resolve();
    await coordinator.waitForIdle("thread-finish-observer-race");

    expect(runtime.complete).toHaveBeenCalledTimes(4);
    expect(finishEvents).toBe(2);
    expect((await store.listRuns("thread-finish-observer-race")).map((run) => run.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("keeps final-boundary settlement pending until an exact runnable read succeeds", async () => {
    const enteredCompleteRun = createDeferred<void>();
    const releaseCompleteRun = createDeferred<void>();
    const runtime = createMockRuntime(
      message("first"),
      message("Nothing else to do."),
      message("second"),
      message("Nothing else to do."),
    );
    const store = new CompletionReconciliationFailureStore(enteredCompleteRun, releaseCompleteRun);
    const registry = new TestThreadDefinitionRegistry().register("completion-read-retry", {
      agent: new Agent({
        name: "completion-read-retry",
        instructions: "Reply briefly",
      }),
      runtime,
    });
    await createRuntimeThread(store, {
      id: "thread-completion-read-retry",
      agentKey: "completion-read-retry",
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-completion-read-retry", {
      message: stringToUserMessage("first input"),
      source: "telegram",
    });
    await enteredCompleteRun.promise;
    await coordinator.submitInput("thread-completion-read-retry", {
      message: stringToUserMessage("second input"),
      source: "tui",
    });
    const readsBeforeFailure = store.exactRunnableReads;
    store.failNextExactRunnableRead = true;

    releaseCompleteRun.resolve();
    await waitFor(() => runtime.complete.mock.calls.length === 4);
    await coordinator.waitForIdle("thread-completion-read-retry");

    expect(store.failNextExactRunnableRead).toBe(false);
    expect(store.exactRunnableReads).toBeGreaterThan(readsBeforeFailure + 1);
    expect((await store.listRuns("thread-completion-read-retry")).map((run) => run.status)).toEqual([
      "completed",
      "completed",
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

    const coordinator = await createTestCoordinator({
      store,
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

  it("rereads an ambiguous completion instead of converting it into failure", async () => {
    const runtime = createMockRuntime(message("heartbeat handled"));
    const store = new AmbiguousTerminalStore();
    const registry = new TestThreadDefinitionRegistry().register("ambiguous-complete", {
      agent: new Agent({name: "ambiguous-complete", instructions: "Reply plainly."}),
      runtime,
    });
    await createRuntimeThread(store, {
      id: "thread-ambiguous-complete",
      agentKey: "ambiguous-complete",
    });
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-ambiguous-complete", {
      message: stringToUserMessage("[Heartbeat]"),
      source: "heartbeat",
      metadata: {heartbeat: {kind: "interval"}},
    });
    await coordinator.waitForIdle("thread-ambiguous-complete");

    expect(store.completeCalls).toBe(1);
    expect(store.failCalls).toBe(0);
    expect(await store.listRuns("thread-ambiguous-complete")).toEqual([
      expect.objectContaining({status: "completed"}),
    ]);
  });

  it("retries a transient failed-run settlement until the row is terminal", async () => {
    const runtime = createMockRuntime(createAssistantMessage([{
      type: "toolCall",
      id: "call_ambiguous_crash",
      name: "crash",
      arguments: {},
    }]));
    const store = new AmbiguousTerminalStore();
    const registry = new TestThreadDefinitionRegistry().register("ambiguous-fail", {
      agent: new Agent({
        name: "ambiguous-fail",
        instructions: "Use the tool.",
        tools: [new CrashTool()],
      }),
      runtime,
    });
    await createRuntimeThread(store, {
      id: "thread-ambiguous-fail",
      agentKey: "ambiguous-fail",
    });
    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-ambiguous-fail", {
      message: stringToUserMessage("start"),
      source: "telegram",
    });
    await expect(coordinator.waitForIdle("thread-ambiguous-fail")).rejects.toThrow("crash-tool boom");

    expect(store.failCalls).toBe(2);
    expect(await store.listRuns("thread-ambiguous-fail")).toEqual([
      expect.objectContaining({status: "failed", error: "crash-tool boom"}),
    ]);
  });

  it("exhausts bounded retries after a completed tool without replaying the tool", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const providerError = JSON.stringify({
      error: {
        message: `The server had an error. Bearer ${PROVIDER_CREDENTIAL_SENTINEL} requestId=${PROVIDER_REQUEST_ID_SENTINEL} payload={${PROVIDER_PAYLOAD_SENTINEL}}`,
        type: "server_error",
        code: "server_error",
      },
      status: 503,
      request_id: PROVIDER_REQUEST_ID_SENTINEL,
      debug: {payload: PROVIDER_PAYLOAD_SENTINEL},
    });
    let callCount = 0;
    const runtime: LlmRuntime & {complete: ReturnType<typeof vi.fn>} = {
      complete: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return createAssistantMessage([{
            type: "toolCall",
            id: "call_echo",
            name: "echo",
            arguments: {message: "hi"},
          }]);
        }
        return terminalAssistantError(providerError);
      }),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };
    const echoTool = new EchoTool();
    const toolSideEffect = vi.spyOn(echoTool, "handle");

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("provider-error-agent", {
      agent: new Agent({
        name: "provider-error-agent",
        instructions: "Use tools when needed",
        tools: [echoTool],
      }),
      runtime,
      model: "openai/gpt-4o-mini",
    });

    await createRuntimeThread(store, {
      id: "thread-provider-error",
      agentKey: "provider-error-agent",
    });

    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-provider-error", {
      message: stringToUserMessage("start"),
      source: "telegram",
    });

    await expect(coordinator.waitForIdle("thread-provider-error")).rejects.toThrow(
      "failureKind=provider_server_error",
    );

    const [run] = await store.listRuns("thread-provider-error");
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("Provider runtime failed");
    expect(run?.error).toContain("provider=openai");
    expect(run?.error).toContain("model=gpt-4o-mini");
    expect(run?.error).toContain("stopReason=error");
    expect(run?.error).toContain("failureKind=provider_server_error");
    expect(run?.error).toContain("status=503");
    expect(run?.error).not.toContain("detail=");
    expect(run?.error).toContain("attempts=3; maxAttempts=3; retryExhausted=true");
    for (const sentinel of [
      PROVIDER_CREDENTIAL_SENTINEL,
      PROVIDER_REQUEST_ID_SENTINEL,
      PROVIDER_PAYLOAD_SENTINEL,
    ]) expect(run?.error).not.toContain(sentinel);
    expect(runtime.complete).toHaveBeenCalledTimes(4);
    expect(toolSideEffect).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledTimes(2);

    const transcript = await store.loadTranscriptHistory("thread-provider-error");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:echo",
    ]);
  });

  it("recovers a server error in one run while queuing input behind the exact retried request", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const retryScheduled = createDeferred<void>();
    vi.spyOn(console, "warn").mockImplementation((message) => {
      if (message === "Retrying transient provider model call.") {
        retryScheduled.resolve();
      }
    });
    const serverError = Object.assign(new Error("OpenAI request failed"), {
      status: 501,
      requestID: "req_server_resume",
      error: {
        message: "The server had an error while processing your request.",
        type: "server_error",
        code: "server_error",
      },
    });
    let callCount = 0;
    const runtime: LlmRuntime & { complete: ReturnType<typeof vi.fn> } = {
      complete: vi.fn().mockImplementation(async () => {
        callCount += 1;
        if (callCount === 1) {
          throw serverError;
        }
        if (callCount === 2) {
          return message("automatic retry reply");
        }
        if (callCount === 3) {
          return message("queued input reply");
        }
        return message("idle reroll reply");
      }),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

    const store = new TestThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("provider-server-error-agent", {
      agent: new Agent({
        name: "provider-server-error-agent",
        instructions: "Reply plainly.",
      }),
      runtime,
    });

    await createRuntimeThread(store, {
      id: "thread-provider-server-error",
      agentKey: "provider-server-error-agent",
      model: "openai-codex/gpt-5.4",
    });

    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-provider-server-error", {
      message: stringToUserMessage("worker handoff"),
      source: "worker",
    });
    await retryScheduled.promise;
    await coordinator.submitInput("thread-provider-server-error", {
      message: stringToUserMessage("queued during retry"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-provider-server-error");

    const runs = await store.listRuns("thread-provider-server-error");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    expect(runtime.complete).toHaveBeenCalledTimes(4);
    expect(runtime.complete.mock.calls[1]?.[0]).toBe(runtime.complete.mock.calls[0]?.[0]);
    expect(JSON.stringify(runtime.complete.mock.calls[1]?.[0].context.messages)).not.toContain("queued during retry");
    expect(JSON.stringify(runtime.complete.mock.calls[2]?.[0].context.messages)).toContain("queued during retry");

    const transcript = await store.loadTranscriptHistory("thread-provider-server-error");
    expect(transcript.filter((entry) => entry.origin === "input" && entry.source === "worker")).toHaveLength(1);
    expect(transcript.filter((entry) => entry.origin === "input" && entry.source === "tui")).toHaveLength(1);
    expect(transcript.map((entry) => entry.source)).toEqual([
      "worker",
      "assistant",
      "tui",
      "assistant",
      "runtime",
      "assistant",
    ]);
    expect(transcript.filter((entry) => entry.origin !== "input").every((entry) => entry.runId === runs[0]?.id)).toBe(true);
  });

  it("resets the retry budget for a later run after timeout exhaustion", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const timeout = new Error("Provider request timed out after 20ms.");
    const runtime: LlmRuntime & { complete: ReturnType<typeof vi.fn> } = {
      complete: vi.fn()
        .mockRejectedValueOnce(timeout)
        .mockRejectedValueOnce(timeout)
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce(message("recovered reply"))
        .mockResolvedValueOnce(message("recovered extra pass")),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

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

    const coordinator = await createTestCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-provider-timeout", {
      message: stringToUserMessage("first try"),
      source: "telegram",
    });

    await expect(coordinator.waitForIdle("thread-provider-timeout")).rejects.toThrow(
      "failureKind=provider_timeout",
    );

    let runs = await store.listRuns("thread-provider-timeout");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.error).toContain("failureKind=provider_timeout");
    expect(runs[0]?.error).toContain("attempts=3; maxAttempts=3; retryExhausted=true");
    expect(await store.listRunningRuns()).toEqual([]);

    await coordinator.submitInput("thread-provider-timeout", {
      message: stringToUserMessage("second try"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-provider-timeout");

    runs = await store.listRuns("thread-provider-timeout");
    expect(runs.map((run) => run.status)).toEqual(["failed", "completed"]);
    expect(runtime.complete).toHaveBeenCalledTimes(5);

    const transcript = await store.loadTranscriptHistory("thread-provider-timeout");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "tui",
      "assistant",
      "runtime",
      "assistant",
    ]);
  });

});

describe("Thread hard context window guard", () => {
  it("does not call the provider when final assembled request exceeds the hard context window", async () => {
    const runtime = createMockRuntime(message("should not run"));
    const thread = new Thread({
      agent: new Agent({
        name: "hard-window-agent",
        instructions: "Reply briefly " + "i".repeat(200),
      }),
      messages: [stringToUserMessage("oversized assembled request " + "x".repeat(300))],
      systemPrompt: "system context " + "s".repeat(200),
      model: TEST_MODEL_WINDOW_350,
      runtime,
      countTokens: (text) => text.length,
    });

    await expect(thread.runToCompletion()).rejects.toThrow(ContextWindowExceededError);
    expect(runtime.complete).not.toHaveBeenCalled();
  });
});

describe("Thread runtime stores", () => {
  it("requires session-backed thread creation in the test store", async () => {
    const store = new TestThreadRuntimeStore();

    await expect(store.createThread({
      id: "missing-session-thread",
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

  it("keeps identical external message ids from separate connector accounts distinct", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, { id: "connector-scoped-inputs", agentKey: "panda" });

    const enqueue = (connectorKey: string) => store.enqueueInput("connector-scoped-inputs", {
      message: stringToUserMessage(`hello from ${connectorKey}`),
      source: "telegram",
      channelId: "chat-1",
      externalMessageId: "message-1",
      metadata: {
        route: {
          source: "telegram",
          connectorKey,
          externalConversationId: "chat-1",
        },
      },
    });

    expect((await enqueue("bot-1")).disposition).toBe("inserted");
    expect((await enqueue("bot-1")).disposition).toBe("duplicate_pending");
    expect((await enqueue("bot-2")).disposition).toBe("inserted");
  });

  it("resolves stable input retries across reset only within the owning session", async () => {
    const store = new TestThreadRuntimeStore();
    const inputId = "11111111-1111-4111-8111-111111111111";
    await createRuntimeThread(store, {
      id: "retry-before-reset",
      sessionId: "retry-session",
      agentKey: "panda",
    });
    await store.enqueueInput("retry-before-reset", {
      message: stringToUserMessage("durable work"),
      source: "runtime",
    }, "queue", {inputId});
    await store.discardPendingInputs("retry-before-reset");
    await createRuntimeThread(store, {
      id: "retry-after-reset",
      sessionId: "retry-session",
      agentKey: "panda",
    });

    await expect(store.enqueueSessionInput("retry-session", {
      message: stringToUserMessage("retry"),
      source: "runtime",
    }, "wake", {inputId})).resolves.toMatchObject({
      disposition: "duplicate_discarded",
      input: {id: inputId, threadId: "retry-before-reset"},
    });

    await createRuntimeThread(store, {
      id: "other-session-thread",
      sessionId: "other-session",
      agentKey: "panda",
    });
    await expect(store.enqueueSessionInput("other-session", {
      message: stringToUserMessage("collision"),
      source: "runtime",
    }, "wake", {inputId})).rejects.toThrow("did not resolve to a durable input");
  });

  it("rejects direct mutations aimed at a retired thread", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, {
      id: "retired-thread",
      sessionId: "retired-session",
      agentKey: "panda",
    });
    await createRuntimeThread(store, {
      id: "replacement-thread",
      sessionId: "retired-session",
      agentKey: "panda",
    });

    await expect(store.requestWake("retired-thread")).rejects.toThrow(
      "Unknown thread retired-thread",
    );
    await expect(store.enqueueInput("retired-thread", {
      message: stringToUserMessage("stale delivery"),
      source: "runtime",
    })).rejects.toThrow("Unknown thread retired-thread");
    await expect(store.wakePendingInputs("retired-thread")).resolves.toEqual([]);
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

    const run = await startTestRun(store, "metadata-thread");
    const applied = await store.applyPendingInputs("metadata-thread", run.id);
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
    await expect(store.loadActiveTranscript("metadata-thread")).resolves.toMatchObject({records: [
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
    ]});
  });

  it("summarizes threads without loading transcripts for each thread", async () => {
    const store = new TestThreadRuntimeStore();
    await createRuntimeThread(store, { id: "summary-a", agentKey: "panda" });
    await createRuntimeThread(store, { id: "summary-b", agentKey: "panda" });

    await store.enqueueInput("summary-a", {
      message: stringToUserMessage("hello"),
      source: "telegram",
    });
    const run = await startTestRun(store, "summary-a");
    await store.applyPendingInputs("summary-a", run.id);
    await store.appendRuntimeMessage("summary-a", {
      message: message("reply"),
      source: "assistant",
    });
    await store.completeRun(run.id);

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
