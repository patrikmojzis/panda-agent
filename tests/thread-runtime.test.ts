import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import {
  Agent,
  createCompactBoundaryMessage,
  DEFAULT_IDENTITY_ID,
  InMemoryIdentityStore,
  InMemoryThreadRuntimeStore,
  Thread,
  ThreadRuntimeCoordinator,
  type ThreadMessageRecord,
  Tool,
  RunContext,
  type ResolvedThreadDefinition,
  type ThreadDefinitionResolver,
  type ThreadRecord,
  stringToUserMessage,
  z,
  type LlmRuntime,
} from "../src/index.js";

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
    provider: "openai",
    model: "gpt-5.1",
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

class CompleteRunBlockingStore extends InMemoryThreadRuntimeStore {
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

class TestThreadDefinitionRegistry {
  private readonly resolvers = new Map<string, ThreadDefinitionResolver>();

  register(agentKey: string, definition: ResolvedThreadDefinition | ThreadDefinitionResolver): this {
    this.resolvers.set(agentKey, typeof definition === "function" ? definition : async () => definition);
    return this;
  }

  resolve(thread: ThreadRecord): Promise<ResolvedThreadDefinition> {
    const resolver = this.resolvers.get(thread.agentKey);
    if (!resolver) {
      throw new Error(`No thread definition registered for agent key ${thread.agentKey}.`);
    }

    return Promise.resolve(resolver(thread));
  }
}

describe("ThreadRuntimeCoordinator", () => {
  it("clears thinking in the in-memory store when updated to null", async () => {
    const store = new InMemoryThreadRuntimeStore();

    await store.createThread({
      id: "thread-thinking",
      agentKey: "panda",
      thinking: "medium",
    });

    const updated = await store.updateThread("thread-thinking", { thinking: null });

    expect(updated.thinking).toBeUndefined();
    expect((await store.getThread("thread-thinking")).thinking).toBeUndefined();
  });

  it("queues wakes until they are flushed", async () => {
    const runtime = createMockRuntime(message("queued reply"));
    const store = new InMemoryThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("queued-agent", {
      agent: new Agent({
        name: "queued-agent",
        instructions: "Reply briefly",
      }),
      runtime,
    });

    await store.createThread({
      id: "thread-queued",
      agentKey: "queued-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
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

    expect(runtime.complete).toHaveBeenCalledTimes(1);

    const transcript = await store.loadTranscript("thread-queued");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
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
      message("processed after flush"),
    );

    const store = new InMemoryThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("queued-during-run", {
      agent: new Agent({
        name: "queued-during-run",
        instructions: "Use tools when needed",
        tools: [new SlowTool(started, release)],
      }),
      runtime,
    });

    await store.createThread({
      id: "thread-queued-during-run",
      agentKey: "queued-during-run",
    });

    const coordinator = new ThreadRuntimeCoordinator({
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

    expect(runtime.complete).toHaveBeenCalledTimes(2);
    expect(await store.hasPendingInputs("thread-queued-during-run")).toBe(true);
    expect(await store.hasRunnableInputs("thread-queued-during-run")).toBe(false);

    let transcript = await store.loadTranscript("thread-queued-during-run");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:slow",
      "assistant",
    ]);

    await coordinator.flushQueued("thread-queued-during-run");
    await coordinator.waitForIdle("thread-queued-during-run");

    expect(runtime.complete).toHaveBeenCalledTimes(3);
    transcript = await store.loadTranscript("thread-queued-during-run");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:slow",
      "assistant",
      "tui",
      "assistant",
    ]);
  });

  it("restarts wake inputs that arrive during exclusive work once the lease is released", async () => {
    const runtime = createMockRuntime(message("processed after exclusive work"));
    const store = new InMemoryThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("exclusive-agent", {
      agent: new Agent({
        name: "exclusive-agent",
        instructions: "Reply briefly",
      }),
      runtime,
    });

    await store.createThread({
      id: "thread-exclusive",
      agentKey: "exclusive-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
      store,
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

    expect(runtime.complete).toHaveBeenCalledTimes(1);
    expect((await store.loadTranscript("thread-exclusive")).map((entry) => entry.source)).toEqual([
      "tui",
      "assistant",
    ]);
  });

  it("replans after a new input arrives during a tool run", async () => {
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
    );

    const store = new InMemoryThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("runtime-agent", {
      agent: new Agent({
        name: "runtime-agent",
        instructions: "Use tools when needed",
        tools: [new SlowTool(started, release), new EchoTool()],
      }),
      runtime,
    });

    await store.createThread({
      id: "thread-replan",
      agentKey: "runtime-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
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

    expect(runtime.complete).toHaveBeenCalledTimes(2);

    const transcript = await store.loadTranscript("thread-replan");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:slow",
      "tool:echo",
      "tui",
      "assistant",
    ]);

    const cancelledResult = transcript[3];
    expect(cancelledResult?.message).toMatchObject({
      role: "toolResult",
      toolName: "echo",
      isError: true,
      details: {
        cancelled: true,
        reason: "New external input arrived.",
      },
    });
  });

  it("interrupts before the first tool starts when new input arrives after the assistant reply", async () => {
    const runtime = new DeferredRuntime();
    const firstResponse = createDeferred<AssistantMessage>();
    runtime.queue(firstResponse.promise);
    runtime.queue(message("replanned after assistant"));
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

    const store = new InMemoryThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("assistant-checkpoint", {
      agent: new Agent({
        name: "assistant-checkpoint",
        instructions: "Use tools when needed",
        tools: [new SpiedEchoTool()],
      }),
      runtime,
    });

    await store.createThread({
      id: "thread-after-assistant",
      agentKey: "assistant-checkpoint",
    });

    const coordinator = new ThreadRuntimeCoordinator({
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

    expect(slowHandle).not.toHaveBeenCalled();

    const transcript = await store.loadTranscript("thread-after-assistant");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tool:echo",
      "tui",
      "assistant",
    ]);
    expect(transcript[2]?.message).toMatchObject({
      role: "toolResult",
      toolName: "echo",
      details: {
        cancelled: true,
        reason: "New external input arrived.",
      },
    });
  });

  it("rebuilds model context from the latest compact boundary plus later messages", async () => {
    const runtime = createMockRuntime(message("after compact"));
    const store = new InMemoryThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("compact-agent", {
      agent: new Agent({
        name: "compact-agent",
        instructions: "Reply briefly",
      }),
      runtime,
    });

    await store.createThread({
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
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await coordinator.submitInput("thread-compact-context", {
      message: stringToUserMessage("new request"),
      source: "tui",
    });
    await coordinator.waitForIdle("thread-compact-context");

    expect(runtime.complete).toHaveBeenCalledTimes(1);
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

  it("recovers only orphaned runs that are not currently leased", async () => {
    const store = new InMemoryThreadRuntimeStore();
    await store.createThread({ id: "thread-free", agentKey: "panda" });
    await store.createThread({ id: "thread-held", agentKey: "panda" });
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

    const store = new InMemoryThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("abort-agent", {
      agent: new Agent({
        name: "abort-agent",
        instructions: "Use tools when needed",
        tools: [new SlowTool(started, release)],
      }),
      runtime,
    });

    await store.createThread({
      id: "thread-abort",
      agentKey: "abort-agent",
    });

    const owner = new ThreadRuntimeCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });
    const observer = new ThreadRuntimeCoordinator({
      store,
      resolveDefinition: (thread) => registry.resolve(thread),
    });

    await owner.submitInput("thread-abort", {
      message: stringToUserMessage("start"),
      source: "telegram",
    });

    await started.promise;

    expect(await observer.abort("thread-abort", "Stop from observer")).toBe(true);
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
      message("second"),
    );

    const store = new CompleteRunBlockingStore(enteredCompleteRun, releaseCompleteRun);
    const registry = new TestThreadDefinitionRegistry().register("completion-race", {
      agent: new Agent({
        name: "completion-race",
        instructions: "Reply briefly",
      }),
      runtime,
    });

    await store.createThread({
      id: "thread-completion-race",
      agentKey: "completion-race",
    });

    const coordinator = new ThreadRuntimeCoordinator({
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

    expect(runtime.complete).toHaveBeenCalledTimes(2);
    const transcript = await store.loadTranscript("thread-completion-race");
    expect(transcript.map((entry) => entry.source)).toEqual([
      "telegram",
      "assistant",
      "tui",
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

    const store = new InMemoryThreadRuntimeStore();
    const registry = new TestThreadDefinitionRegistry().register("crash-agent", {
      agent: new Agent({
        name: "crash-agent",
        instructions: "Use tools when needed",
        tools: [new CrashTool()],
      }),
      runtime,
    });

    await store.createThread({
      id: "thread-crash",
      agentKey: "crash-agent",
    });

    const coordinator = new ThreadRuntimeCoordinator({
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
});

describe("Thread runtime stores", () => {
  it("only exposes the built-in local identity in memory mode", async () => {
    const identityStore = new InMemoryIdentityStore();
    const store = new InMemoryThreadRuntimeStore({ identityStore });
    const localIdentity = await identityStore.getIdentity(DEFAULT_IDENTITY_ID);

    expect(localIdentity.handle).toBe("local");

    await store.createThread({ id: "local-thread", agentKey: "panda" });

    const localSummaries = await store.listThreadSummaries(undefined, DEFAULT_IDENTITY_ID);
    expect(localSummaries).toHaveLength(1);
    expect(localSummaries[0]?.thread.id).toBe("local-thread");
    expect(localSummaries[0]?.thread.identityId).toBe(DEFAULT_IDENTITY_ID);

    const listed = await identityStore.listIdentities();
    expect(listed.map((identity) => identity.handle)).toEqual(["local"]);
    await expect(identityStore.getIdentityByHandle("alice")).rejects.toThrow("Persisted identities require Postgres");
  });

  it("rejects threads created for missing identities", async () => {
    const store = new InMemoryThreadRuntimeStore();

    await expect(store.createThread({
      id: "missing-identity-thread",
      agentKey: "panda",
      identityId: "ghost",
    })).rejects.toThrow("Unknown identity ghost");
  });

  it("dedupes retries per source and channel, not just external message id", async () => {
    const store = new InMemoryThreadRuntimeStore();
    await store.createThread({ id: "identity", agentKey: "panda" });

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
    const store = new InMemoryThreadRuntimeStore();
    await store.createThread({ id: "metadata-thread", agentKey: "panda" });

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

  it("summarizes threads without loading transcripts per caller", async () => {
    const store = new InMemoryThreadRuntimeStore();
    await store.createThread({ id: "summary-a", agentKey: "panda" });
    await store.createThread({ id: "summary-b", agentKey: "panda" });

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
