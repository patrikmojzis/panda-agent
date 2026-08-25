import {DataType, newDb} from "pg-mem";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage} from "@earendil-works/pi-ai";
import {z} from "zod";

import {PostgresModelCallTraceStore} from "../src/domain/model-call-traces/postgres.js";
import {ensurePostgresModelCallTraceSchema} from "../src/domain/model-call-traces/postgres-schema.js";
import {
  BufferedModelCallRecorder,
  type ModelCallAttemptSink,
} from "../src/domain/model-call-traces/recorder.js";
import {buildSanitizedModelCallSnapshot} from "../src/domain/model-call-traces/redaction.js";
import type {ModelCallAttemptWrite} from "../src/domain/model-call-traces/types.js";
import {ensureReadonlySessionQuerySchema} from "../src/domain/threads/runtime/postgres-readonly.js";
import {Agent} from "../src/kernel/agent/agent.js";
import {ProviderRuntimeError} from "../src/kernel/agent/exceptions.js";
import {LlmContext} from "../src/kernel/agent/llm-context.js";
import type {
  LlmModelCallObservation,
  LlmModelCallObserver,
  LlmRuntime,
  LlmRuntimeRequest,
} from "../src/kernel/agent/runtime.js";
import {Thread} from "../src/kernel/agent/thread.js";
import {Tool} from "../src/kernel/agent/tool.js";

const pools: Array<{end(): Promise<void>}> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (pools.length > 0) await pools.pop()?.end();
});

function assistant(text = "done"): AssistantMessage {
  return {
    role: "assistant",
    content: [{type: "text", text}],
    api: "openai-responses",
    model: "openai/gpt-test",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 23,
      cost: {input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033},
    },
    stopReason: "stop",
    timestamp: Date.UTC(2040, 0, 1),
  };
}

class SecretTool extends Tool {
  name = "secret_tool";
  description = "Tool used by recorder redaction tests.";
  schema = z.object({value: z.string().optional(), imageData: z.string().optional()});

  override redactCallArguments(args: Record<string, unknown>): Record<string, unknown> {
    return {...args, value: "[tool arg redacted]"};
  }

  override redactResultMessage(message: Parameters<Tool["redactResultMessage"]>[0]): Parameters<Tool["redactResultMessage"]>[0] {
    return {
      ...message,
      content: [{type: "text", text: "[tool result redacted]"}],
      details: {redacted: true},
    };
  }

  async handle() {
    return {ok: true};
  }
}

class TraceContext extends LlmContext {
  override name = "TraceContext";
  override source = "test-context-source";

  constructor(private readonly value = "trace context value") {
    super();
  }

  async getSnapshot() {
    return {
      content: this.value,
      source: this.source,
      promptCacheKeyPart: "context-cache-secret",
    };
  }

  async getContent(): Promise<string> {
    return this.value;
  }
}

class CapturingSink implements ModelCallAttemptSink {
  readonly attempts: ModelCallAttemptWrite[] = [];
  purged = 0;

  async insertAttempts(attempts: readonly ModelCallAttemptWrite[]): Promise<void> {
    this.attempts.push(...attempts);
  }

  async purgeExpiredBatch(): Promise<number> {
    return this.purged;
  }
}

class CompleteRuntime implements LlmRuntime {
  readonly complete = vi.fn(async () => assistant());
  readonly stream = vi.fn(() => {
    throw new Error("stream not used");
  });
}

class RecoveringRuntime implements LlmRuntime {
  readonly complete = vi.fn()
    .mockRejectedValueOnce(new ProviderRuntimeError("temporary provider failure", {
      providerName: "openai",
      modelId: "gpt-test",
      status: 503,
      retryable: true,
      failureKind: "provider_server_error",
      providerMessage: "temporary provider failure requestId=req-sensitive-value",
    }))
    .mockResolvedValue(assistant());

  readonly stream = vi.fn(() => {
    throw new Error("stream not used");
  });
}

function createObservation(overrides: Partial<LlmModelCallObservation> = {}): LlmModelCallObservation {
  const contextValue = "structured context";
  return {
    mode: "complete",
    attempt: 1,
    startedAt: Date.UTC(2040, 0, 1),
    finishedAt: Date.UTC(2040, 0, 1) + 50,
    tools: [new SecretTool()],
    request: {
      providerName: "openai",
      modelId: "gpt-test",
      promptCacheKey: "trace-cache:raw-secret",
      metadata: {
        runId: "00000000-0000-0000-0000-000000000101",
        threadId: "thread-panda",
        sessionId: "session-panda",
        agentKey: "panda",
        turn: 4,
      },
      context: {
        systemPrompt: `base instructions\n\n${contextValue}`,
        messages: [{role: "user", content: "hello"}],
        tools: [],
      },
      trace: {
        llmContextSections: [{
          name: "TraceContext",
          source: "test-context-source",
          contentPreview: contextValue,
          contentChars: contextValue.length,
          estimatedTokens: 4,
          dumpChars: contextValue.length + 20,
        }],
      },
    },
    response: assistant(),
    ...overrides,
  };
}

function createThread(runtime: LlmRuntime, observer: LlmModelCallObserver): Thread {
  return new Thread({
    agent: new Agent({name: "panda", instructions: "base instructions", tools: [new SecretTool()]}),
    messages: [{role: "user", content: "hello"}],
    context: {
      runId: "00000000-0000-0000-0000-000000000101",
      threadId: "thread-panda",
      sessionId: "session-panda",
      agentKey: "panda",
    },
    llmContexts: [new TraceContext()],
    promptCacheKey: "thread:trace-test",
    model: "openai/gpt-test",
    runtime,
    modelCallObserver: observer,
  });
}

async function drainThread(thread: Thread): Promise<void> {
  for await (const _event of thread.run()) {
    // Drain the public generator exactly as runtime callers do.
  }
}

async function createStore() {
  const db = newDb({noAstCoverageCheck: true});
  db.public.registerFunction({
    name: "current_setting",
    args: [DataType.text, DataType.bool],
    returns: DataType.text,
    implementation: () => "session-panda",
  });
  db.public.registerFunction({
    name: "floor",
    args: [DataType.float],
    returns: DataType.float,
    implementation: Math.floor,
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  pools.push(pool);
  const store = new PostgresModelCallTraceStore({pool});
  await ensurePostgresModelCallTraceSchema(pool);
  return {pool, store};
}

describe("model call flight recorder", () => {
  it("rejects a snapshot cap larger than the recorder queue budget", () => {
    expect(() => new BufferedModelCallRecorder({
      sink: new CapturingSink(),
      snapshotMaxBytes: 128 * 1024,
      maxQueueBytes: 64 * 1024,
    })).toThrow("snapshot max bytes cannot exceed");
  });

  it("cannot change a successful model-call outcome when observation fails", async () => {
    const runtime = new CompleteRuntime();
    const observer: LlmModelCallObserver = {
      observeModelCall: () => {
        throw new Error("trace database unavailable");
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(drainThread(createThread(runtime, observer))).resolves.toBeUndefined();
    expect(runtime.complete).toHaveBeenCalledOnce();
  });

  it("records lightweight metadata for successful calls without retaining request objects", async () => {
    const sink = new CapturingSink();
    const recorder = new BufferedModelCallRecorder({sink, successSnapshotSampleRate: 0});

    recorder.observeModelCall(createObservation());
    expect(sink.attempts).toHaveLength(0);
    await recorder.flush();

    expect(sink.attempts).toHaveLength(1);
    expect(sink.attempts[0]).toMatchObject({
      attempt: 1,
      status: "completed",
      snapshotStatus: "not_captured",
      usage: {totalTokens: 23},
      requestShape: {messageCount: 1, contextSectionCount: 1},
    });
    expect(sink.attempts[0]?.snapshot).toBeUndefined();
  });

  it("assigns distinct attempt ordinals across a successful provider retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sink = new CapturingSink();
    const recorder = new BufferedModelCallRecorder({sink, successSnapshotSampleRate: 0});
    const runtime = new RecoveringRuntime();

    await drainThread(createThread(runtime, recorder));
    await recorder.flush();

    expect(sink.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
    expect(sink.attempts.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
    expect(sink.attempts[0]?.snapshot).toBeDefined();
    expect(sink.attempts[1]?.snapshot).toBeUndefined();
    expect(JSON.stringify(sink.attempts[0]?.failure)).not.toContain("req-sensitive-value");
    const providerRequest = runtime.complete.mock.calls[0]?.[0];
    expect(providerRequest?.trace).not.toHaveProperty("llmContextDump");
    expect(providerRequest?.trace?.llmContextSections?.[0]).not.toHaveProperty("content");
    expect(providerRequest?.trace?.llmContextSections?.[0]).not.toHaveProperty("dump");
    expect(providerRequest?.trace?.llmContextSections?.[0]).not.toHaveProperty("promptCacheKeyPart");
  });

  it("bounds malformed failure metadata before it reaches indexed columns", async () => {
    const sink = new CapturingSink();
    const recorder = new BufferedModelCallRecorder({sink});
    const error = new Error("provider failed");
    error.name = `token=secret-value-${"x".repeat(5_000)}`;

    recorder.observeModelCall(createObservation({
      error,
      response: undefined,
    }));
    await recorder.flush();

    expect(sink.attempts[0]?.failure?.category.length).toBeLessThanOrEqual(128);
    expect(sink.attempts[0]?.failure?.category).not.toContain("secret-value");
  });

  it("defers snapshot sanitization until the background drain", async () => {
    const sink = new CapturingSink();
    const tool = new SecretTool();
    const redact = vi.spyOn(tool, "redactCallArguments");
    const recorder = new BufferedModelCallRecorder({sink, batchSize: 1});
    const observation = createObservation({
      tools: [tool],
      error: new Error("provider failed"),
      response: undefined,
      request: {
        ...createObservation().request,
        context: {
          ...createObservation().request.context,
          messages: [{
            role: "assistant",
            content: [{type: "toolCall", id: "tool-1", name: "secret_tool", arguments: {value: "secret"}}],
            api: "openai-responses",
            model: "openai/gpt-test",
            usage: assistant().usage,
            stopReason: "toolUse",
            timestamp: Date.UTC(2040, 0, 1),
          }],
        },
      },
    });

    recorder.observeModelCall(observation);
    expect(redact).not.toHaveBeenCalled();
    await recorder.flush();
    expect(redact).toHaveBeenCalledOnce();
    const serialized = JSON.stringify(sink.attempts[0]?.snapshot);
    expect(serialized).toContain("[tool arg redacted]");
    expect(serialized).not.toContain('"value":"secret"');
    expect(serialized).not.toContain("trace-cache:raw-secret");
    expect(serialized).not.toContain("context-cache-secret");
  });

  it("prepares new snapshots while an earlier database batch is blocked", async () => {
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const attempts: ModelCallAttemptWrite[] = [];
    let writes = 0;
    const sink: ModelCallAttemptSink = {
      insertAttempts: async (batch) => {
        writes += 1;
        if (writes === 1) await firstWriteBlocked;
        attempts.push(...batch);
      },
      purgeExpiredBatch: async () => 0,
    };
    const firstTool = new SecretTool();
    const secondTool = new SecretTool();
    const firstRedactor = vi.spyOn(firstTool, "redactCallArguments");
    const secondRedactor = vi.spyOn(secondTool, "redactCallArguments");
    const withToolCall = (tool: SecretTool, attempt: number): LlmModelCallObservation => createObservation({
      attempt,
      tools: [tool],
      error: new Error("provider failed"),
      response: undefined,
      request: {
        ...createObservation().request,
        context: {
          ...createObservation().request.context,
          messages: [{
            role: "assistant",
            content: [{type: "toolCall", id: `tool-${attempt}`, name: "secret_tool", arguments: {value: "secret"}}],
            api: "openai-responses",
            model: "openai/gpt-test",
            usage: assistant().usage,
            stopReason: "toolUse",
            timestamp: Date.UTC(2040, 0, 1),
          }],
        },
      },
    });
    const recorder = new BufferedModelCallRecorder({sink, batchSize: 1});

    recorder.observeModelCall(withToolCall(firstTool, 1));
    await vi.waitFor(() => expect(writes).toBe(1));
    expect(firstRedactor).toHaveBeenCalledOnce();

    recorder.observeModelCall(withToolCall(secondTool, 2));
    await vi.waitFor(() => expect(secondRedactor).toHaveBeenCalledOnce());
    expect(attempts).toHaveLength(0);

    releaseFirstWrite();
    await recorder.flush();
    expect(attempts.map((attempt) => attempt.attempt)).toEqual([1, 2]);
  });

  it("drains once on close and rejects later observations without throwing", async () => {
    const sink = new CapturingSink();
    const recorder = new BufferedModelCallRecorder({sink});
    recorder.observeModelCall(createObservation());

    await Promise.all([recorder.close(), recorder.close()]);
    expect(sink.attempts).toHaveLength(1);

    recorder.observeModelCall(createObservation({attempt: 2}));
    expect(recorder.snapshotStats()).toMatchObject({
      queuedItems: 0,
      droppedAttempts: 1,
      writtenAttempts: 1,
    });
  });

  it("drops oversized tool payloads before invoking tool-owned redactors", () => {
    const tool = new SecretTool();
    const redact = vi.spyOn(tool, "redactCallArguments");
    const observation = createObservation({
      tools: [tool],
      request: {
        ...createObservation().request,
        context: {
          ...createObservation().request.context,
          messages: [{
            role: "assistant",
            content: [{
              type: "toolCall",
              id: "tool-large",
              name: "secret_tool",
              arguments: {value: "x".repeat(128 * 1024)},
            }],
            api: "openai-responses",
            model: "openai/gpt-test",
            usage: assistant().usage,
            stopReason: "toolUse",
            timestamp: Date.UTC(2040, 0, 1),
          }],
        },
      },
    });

    const snapshot = buildSanitizedModelCallSnapshot(observation, 64 * 1024);
    expect(redact).not.toHaveBeenCalled();
    expect(JSON.stringify(snapshot.requestJson)).toContain("tool_arguments_capture_budget");
    expect(snapshot.bytes).toBeLessThanOrEqual(64 * 1024);
  });

  it("deduplicates context and hard-caps forensic snapshots", () => {
    const contextValue = "context value with punctuation. ".repeat(20_000);
    const userValue = "large user message with punctuation. ".repeat(20_000);
    const observation = createObservation({
      request: {
        ...createObservation().request,
        context: {
          ...createObservation().request.context,
          systemPrompt: `base\n\n${contextValue}`,
          messages: [{role: "user", content: userValue}],
        },
        trace: {
          llmContextSections: [{
            name: "LargeContext",
            contentPreview: contextValue.slice(0, 500),
            contentChars: contextValue.length,
            estimatedTokens: Math.ceil(contextValue.length / 4),
            dumpChars: contextValue.length,
          }],
        },
      },
    });

    const snapshot = buildSanitizedModelCallSnapshot(observation, 64 * 1024);
    const serialized = JSON.stringify(snapshot.requestJson);

    expect(snapshot.bytes).toBeLessThanOrEqual(64 * 1024);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.requestJson).not.toHaveProperty("llmContextDump");
    expect(serialized).not.toContain('"content":"context value');
    expect(serialized).not.toContain('"dump":"context value');
    expect(snapshot.requestJson.llmContextSections).toEqual([
      expect.objectContaining({name: "LargeContext", contentChars: contextValue.length}),
    ]);
  });

  it("enforces the queue byte budget by dropping snapshots before attempt metadata", async () => {
    const sink = new CapturingSink();
    const snapshotMaxBytes = 64 * 1024;
    const recorder = new BufferedModelCallRecorder({
      sink,
      snapshotMaxBytes,
      maxQueueBytes: snapshotMaxBytes + 512,
      maxQueueItems: 10,
      batchSize: 10,
    });
    const failure = new Error("provider failed");

    recorder.observeModelCall(createObservation({error: failure, response: undefined}));
    recorder.observeModelCall(createObservation({attempt: 2, error: failure, response: undefined}));

    expect(recorder.snapshotStats()).toMatchObject({
      queuedItems: 2,
      droppedAttempts: 0,
      droppedSnapshots: 1,
    });
    await recorder.flush();
    expect(sink.attempts.map((attempt) => attempt.snapshotStatus).sort()).toEqual(["captured", "dropped"]);
  });

  it("stores narrow list rows and loads snapshots only for detail", async () => {
    const {pool, store} = await createStore();
    const recorder = new BufferedModelCallRecorder({sink: store, successSnapshotSampleRate: 1});
    recorder.observeModelCall(createObservation());
    await recorder.flush();

    const querySpy = vi.spyOn(pool, "query");
    const listed = await store.listTraces();
    const listSql = querySpy.mock.calls.map(([sql]) => String(sql)).join("\n");
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0]?.snapshot).toBeUndefined();
    expect(listSql).not.toContain("request_json");
    expect(listSql).not.toContain("model_call_snapshots");

    const detail = await store.getTrace(listed.data[0]!.id);
    expect(detail?.snapshot).toMatchObject({truncated: false});
    expect(detail?.snapshot?.requestJson).not.toHaveProperty("llmContextDump");
  });

  it("groups failures with a fixed query count and keeps snapshot payloads out of the path", async () => {
    const {pool, store} = await createStore();
    const recorder = new BufferedModelCallRecorder({sink: store});
    for (const [attempt, errorName] of [[1, "provider_timeout"], [2, "provider_timeout"], [3, "tool_schema"]] as const) {
      const error = new Error(`${errorName} ${attempt}`);
      error.name = errorName;
      recorder.observeModelCall(createObservation({
        attempt,
        startedAt: Date.UTC(2040, 0, 1, 0, attempt),
        finishedAt: Date.UTC(2040, 0, 1, 0, attempt) + 50,
        error,
        response: undefined,
      }));
    }
    await recorder.flush();

    const querySpy = vi.spyOn(pool, "query");
    await expect(store.listFailureGroups({}, 3)).resolves.toMatchObject([
      {count: 2, label: "provider_timeout", summary: "provider_timeout 2"},
      {count: 1, label: "tool_schema", summary: "tool_schema 3"},
    ]);
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(querySpy.mock.calls.map(([sql]) => String(sql)).join("\n")).not.toContain("model_call_snapshots");
  });

  it("aggregates usage into bounded database buckets", async () => {
    const {store} = await createStore();
    const recorder = new BufferedModelCallRecorder({sink: store});
    const from = Date.UTC(2040, 0, 1);
    recorder.observeModelCall(createObservation({
      attempt: 1,
      startedAt: from + 10 * 60_000,
      finishedAt: from + 10 * 60_000 + 50,
    }));
    recorder.observeModelCall(createObservation({
      attempt: 2,
      startedAt: from + 70 * 60_000,
      finishedAt: from + 70 * 60_000 + 50,
    }));
    await recorder.flush();

    await expect(store.listUsageBuckets({from, to: from + 2 * 60 * 60_000, bucketMs: 60 * 60_000}))
      .resolves.toEqual([
        expect.objectContaining({startedAt: from, calls: 1, usageCalls: 1, totalTokens: 23}),
        expect.objectContaining({startedAt: from + 60 * 60_000, calls: 1, usageCalls: 1, totalTokens: 23}),
      ]);
  });

  it("purges snapshots and metadata in bounded batches", async () => {
    const {store} = await createStore();
    const expired = Date.UTC(2039, 0, 1);
    const observation = createObservation({finishedAt: expired - 100});
    const sink = new BufferedModelCallRecorder({
      sink: store,
      now: () => expired,
      successSnapshotSampleRate: 1,
      attemptRetentionDays: 1,
      snapshotRetentionDays: 1,
    });
    sink.observeModelCall(observation);
    await sink.flush();

    await store.purgeExpiredBatch(expired + 2 * 24 * 60 * 60 * 1_000, 10);
    await expect(store.listTraces()).resolves.toMatchObject({data: []});
  });

  it("preserves the capture outcome after the short-lived snapshot expires", async () => {
    const {store} = await createStore();
    const finishedAt = Date.UTC(2040, 0, 1);
    const recorder = new BufferedModelCallRecorder({
      sink: store,
      successSnapshotSampleRate: 1,
      attemptRetentionDays: 90,
      snapshotRetentionDays: 1,
    });
    recorder.observeModelCall(createObservation({finishedAt}));
    await recorder.flush();
    const [attempt] = (await store.listTraces()).data;

    await store.purgeExpiredBatch(finishedAt + 2 * 24 * 60 * 60 * 1_000, 10);
    const detail = await store.getTrace(attempt!.id);
    expect(detail?.snapshotStatus).toBe("captured");
    expect(detail?.snapshot).toBeUndefined();
  });

  it("does not expose model-call telemetry through session readonly SQL", async () => {
    const queries: string[] = [];
    const views = await ensureReadonlySessionQuerySchema({
      queryable: {
        query: async (sql: string) => {
          queries.push(sql);
          return {rows: []};
        },
      },
    });

    expect(Object.values(views).join(" ")).not.toContain("model_call");
    expect(queries.join("\n")).not.toContain("model_call_attempt");
    expect(queries.join("\n")).not.toContain("model_call_snapshot");
  });
});
