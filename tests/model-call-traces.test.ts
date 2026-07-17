import {DataType, newDb} from "pg-mem";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage, AssistantMessageEventStream} from "@earendil-works/pi-ai";
import {z} from "zod";

import {Agent} from "../src/kernel/agent/agent.js";
import {ProviderRuntimeError} from "../src/kernel/agent/exceptions.js";
import {LlmContext} from "../src/kernel/agent/llm-context.js";
import type {LlmRuntime, LlmRuntimeRequest} from "../src/kernel/agent/runtime.js";
import {Thread} from "../src/kernel/agent/thread.js";
import {Tool} from "../src/kernel/agent/tool.js";
import {PostgresModelCallTraceStore} from "../src/domain/model-call-traces/postgres.js";
import {ensureReadonlySessionQuerySchema} from "../src/domain/threads/runtime/postgres-readonly.js";

const pools: Array<{end(): Promise<void>}> = [];
const PROMPT_CACHE_KEY_REDACTION_PATTERN = /^\[redacted:prompt-cache-key:sha256:[a-f0-9]{16}\]$/;
const TRACE_CONTEXT_CONTENT = "llm context section with trace-context-value";
const TRACE_CONTEXT_CACHE_PART = "trace-context-cache-raw-secret";
const FUTURE_CONTEXT_CONTENT = "future llm context section with auto-display-value";

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  while (pools.length > 0) await pools.pop()?.end();
});

async function createStore() {
  const db = newDb({noAstCoverageCheck: true});
  db.public.registerFunction({name: "current_setting", args: [DataType.text, DataType.bool], returns: DataType.text, implementation: () => "session-panda"});
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  pools.push(pool);
  const store = new PostgresModelCallTraceStore({pool});
  await store.ensureSchema();
  return {pool, store};
}

function assistant(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
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
    ...overrides,
  };
}

class SecretTool extends Tool {
  name = "secret_tool";
  description = "Tool used by trace redaction tests.";
  schema = z.object({value: z.string().optional(), imageData: z.string().optional()});

  override redactCallArguments(args: Record<string, unknown>): Record<string, unknown> {
    return {
      ...args,
      value: "[tool arg redacted]",
    };
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
  override label = "Trace context label";

  async getSnapshot() {
    return {
      content: TRACE_CONTEXT_CONTENT,
      promptCacheKeyPart: TRACE_CONTEXT_CACHE_PART,
      label: this.label,
      source: this.source,
    };
  }

  async getContent(): Promise<string> {
    return TRACE_CONTEXT_CONTENT;
  }
}


class FutureTraceContext extends LlmContext {
  override name = "FutureTraceContext";
  override source = "future-context-source";
  override label = "Future context label";

  async getSnapshot() {
    return {
      content: FUTURE_CONTEXT_CONTENT,
      label: this.label,
      source: this.source,
    };
  }

  async getContent(): Promise<string> {
    return FUTURE_CONTEXT_CONTENT;
  }
}

class CompleteRuntime implements LlmRuntime {
  readonly complete = vi.fn(async (_request: LlmRuntimeRequest) => assistant("done"));
  readonly stream = vi.fn(() => {
    throw new Error("stream not used");
  });
}

class FailingRuntime implements LlmRuntime {
  readonly complete = vi.fn(async () => {
    throw new ProviderRuntimeError(
      "Provider runtime failed; detail=Bearer abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrstuvwxyz {\"messages\":[{\"content\":\"raw provider payload\"}]}",
      {
        providerName: "openai",
        modelId: "gpt-test",
        failureKind: "provider_timeout",
        providerMessage: "timeout Bearer provider-bearer-abcdefghijklmnopqrstuvwxyz token=sk-abcdefghijklmnopqrstuvwxyz {\"messages\":[{\"content\":\"raw provider payload\"}]}",
        status: 504,
        requestId: "request-secret-token=abcdef1234567890",
        timedOut: true,
      },
    );
  });
  readonly stream = vi.fn(() => {
    throw new Error("stream not used");
  });
}

function streamFor(result: AssistantMessage): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => result,
  } as AssistantMessageEventStream;
}

class RecoveringRuntime implements LlmRuntime {
  readonly complete = vi.fn()
    .mockRejectedValueOnce(new ProviderRuntimeError(
      "Provider runtime failed; detail=try again later {\"messages\":[{\"content\":\"raw retry payload\"}]}",
      {
        providerName: "openai",
        modelId: "gpt-test",
        failureKind: "provider_server_error",
        providerMessage: "try again later {\"messages\":[{\"content\":\"raw retry payload\"}]}",
        status: 503,
        retryable: true,
      },
    ))
    .mockResolvedValue(assistant("recovered"));
  readonly stream = vi.fn(() => {
    throw new Error("stream not used");
  });
}

class StreamRuntime implements LlmRuntime {
  readonly complete = vi.fn(async () => assistant("not used"));
  readonly stream = vi.fn((_request: LlmRuntimeRequest) => streamFor(assistant("streamed")));
}

async function drainThread(thread: Thread): Promise<void> {
  for await (const _event of thread.run()) {
    // Drain the generator so the model call completes.
  }
}

async function drainStream(thread: Thread): Promise<void> {
  for await (const _event of thread.stream()) {
    // Drain the generator so the stream result is observed once.
  }
}

function createThread(input: {runtime: LlmRuntime; store: PostgresModelCallTraceStore; messages?: LlmRuntimeRequest["context"]["messages"]; promptCacheKey?: string; llmContexts?: LlmContext[]}) {
  return new Thread({
    agent: new Agent({name: "panda", instructions: "base instructions", tools: [new SecretTool()]}),
    messages: input.messages ?? [{role: "user", content: "hello"}],
    context: {
      runId: "00000000-0000-0000-0000-000000000101",
      threadId: "thread-panda",
      sessionId: "session-panda",
      agentKey: "panda",
    },
    llmContexts: input.llmContexts ?? [new TraceContext()],
    promptCacheKey: input.promptCacheKey ?? "thread:trace-test",
    model: "openai/gpt-test",
    runtime: input.runtime,
    modelCallTracer: input.store,
  });
}

describe("model call traces", () => {
  it("writes one completed trace for a successful non-stream model call with context snapshots", async () => {
    const {store} = await createStore();
    const runtime = new CompleteRuntime();

    await drainThread(createThread({runtime, store}));

    const traces = await store.listTraces();
    expect(traces.data).toHaveLength(1);
    const trace = traces.data[0]!;
    expect(trace).toMatchObject({
      runId: "00000000-0000-0000-0000-000000000101",
      threadId: "thread-panda",
      sessionId: "session-panda",
      agentKey: "panda",
      provider: "openai",
      model: "gpt-test",
      mode: "complete",
      status: "completed",
      promptCacheKey: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
      usageJson: expect.objectContaining({input: 11, output: 7, totalTokens: 23}),
    });
    expect(trace.durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.expiresAt).toBeGreaterThan(trace.finishedAt);
    expect(trace.requestJson.promptCacheKey).toEqual(expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN));
    expect(JSON.stringify(trace)).not.toContain("thread:trace-test");
    expect(trace.requestJson.systemPrompt).toEqual(expect.stringContaining("base instructions"));
    expect(trace.requestJson.systemPrompt).toEqual(expect.stringContaining("trace-context-value"));
    expect(trace.requestJson.messages).toEqual([expect.objectContaining({role: "user", content: "hello"})]);
    expect(trace.requestJson.tools).toEqual([expect.objectContaining({name: "secret_tool"})]);
    expect(trace.requestJson.llmContextDump).toEqual(expect.stringContaining("TraceContext"));
    expect(trace.requestJson.llmContextSections).toEqual([
      expect.objectContaining({
        name: "TraceContext",
        source: "test-context-source",
        label: "Trace context label",
        content: expect.stringContaining("trace-context-value"),
        contentPreview: TRACE_CONTEXT_CONTENT,
        contentChars: TRACE_CONTEXT_CONTENT.length,
        estimatedTokens: Math.ceil(TRACE_CONTEXT_CONTENT.length / 4),
        dump: expect.stringContaining("TraceContext"),
        dumpChars: expect.any(Number),
        promptCacheKeyPart: expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN),
      }),
    ]);
    expect(JSON.stringify(trace.requestJson.llmContextSections)).not.toContain(TRACE_CONTEXT_CACHE_PART);
  });

  it("records future LlmContext sections through the runtime dump pipeline", async () => {
    const {store} = await createStore();
    const runtime = new CompleteRuntime();

    await drainThread(createThread({
      runtime,
      store,
      llmContexts: [new TraceContext(), new FutureTraceContext()],
    }));

    const traces = await store.listTraces();
    const sections = traces.data[0]?.requestJson.llmContextSections;
    expect(sections).toEqual([
      expect.objectContaining({name: "TraceContext"}),
      expect.objectContaining({
        name: "FutureTraceContext",
        source: "future-context-source",
        label: "Future context label",
        contentPreview: FUTURE_CONTEXT_CONTENT,
      }),
    ]);
    expect(JSON.stringify(sections)).toContain("auto-display-value");
  });

  it("writes one sanitized failed trace per exhausted physical attempt", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const {store} = await createStore();
    const runtime = new FailingRuntime();

    await expect(drainThread(createThread({runtime, store}))).rejects.toThrow(
      "attempts=3; maxAttempts=3; retryExhausted=true",
    );

    const traces = await store.listTraces();
    expect(traces.data).toHaveLength(3);
    expect(traces.data.map((trace) => trace.status)).toEqual(["failed", "failed", "failed"]);
    expect(traces.data.every((trace) => trace.callIndex === 1)).toBe(true);
    for (const trace of traces.data) {
      expect(trace).toMatchObject({
        runId: "00000000-0000-0000-0000-000000000101",
        threadId: "thread-panda",
        turn: 1,
      });
      expect(trace.errorJson).toMatchObject({category: "provider_timeout", status: 504, timedOut: true});
    }
    const text = JSON.stringify(traces.data);
    for (const sentinel of [
      "provider-bearer-abcdefghijklmnopqrstuvwxyz",
      "sk-abcdefghijklmnopqrstuvwxyz",
      "abcdef1234567890",
      "raw provider payload",
    ]) expect(text).not.toContain(sentinel);
    expect(text).toContain("[redacted:credential]");
    expect(text).toContain("[redacted:request-id]");
  });

  it("records failed and completed traces with common attribution for a successful retry", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const {store} = await createStore();
    const runtime = new RecoveringRuntime();

    await drainThread(createThread({runtime, store}));

    const traces = await store.listTraces();
    expect(traces.data).toHaveLength(2);
    expect(traces.data.map((trace) => trace.status).sort()).toEqual(["completed", "failed"]);
    expect(traces.data.every((trace) => trace.callIndex === 1)).toBe(true);
    expect(traces.data.every((trace) => trace.runId === "00000000-0000-0000-0000-000000000101")).toBe(true);
    expect(traces.data.every((trace) => trace.threadId === "thread-panda")).toBe(true);
    expect(traces.data.every((trace) => trace.turn === 1)).toBe(true);
    expect(JSON.stringify(traces.data)).not.toContain("raw retry payload");
  });

  it("writes one final trace for streaming after the stream result resolves", async () => {
    const {store} = await createStore();
    const runtime = new StreamRuntime();

    await drainStream(createThread({runtime, store}));

    const traces = await store.listTraces();
    expect(traces.data).toHaveLength(1);
    expect(traces.data[0]).toMatchObject({mode: "stream", status: "completed"});
    expect(runtime.stream).toHaveBeenCalledTimes(1);
  });

  it("preserves token-shaped request prose while redacting tool payloads and blobs before persistence", async () => {
    const {pool, store} = await createStore();
    const base64Blob = Buffer.from("private image bytes".repeat(20)).toString("base64");
    const toolCall = {
      role: "assistant" as const,
      content: [{type: "toolCall", id: "call-1", name: "secret_tool", arguments: {value: "unsafe tool secret", imageData: base64Blob}}],
      stopReason: "toolUse" as const,
      api: "openai-responses",
      model: "openai/gpt-test",
      usage: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
      timestamp: Date.now(),
    };
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "secret_tool",
      content: [{type: "image", data: base64Blob, mimeType: "image/png"}],
      details: {apiKey: "secret-key-value", token: "secret-token-value"},
      isError: false,
      timestamp: Date.now(),
    };

    await drainThread(createThread({
      runtime: new CompleteRuntime(),
      store,
      messages: [
        {role: "user", content: `Bearer seededBearerSecret token=sk-seededOpenAiSecret cookie sessionid=seeded-cookie-value https://panda.patrikmojzis.com/apps/open?token=pal_launch-token`},
        toolCall,
        toolResult,
      ],
    }));

    const rows = await pool.query(`SELECT request_json, response_json, error_json, usage_json FROM "runtime"."model_call_traces"`);
    const persisted = JSON.stringify(rows.rows);
    for (const sentinel of [
      "seededBearerSecret",
      "sk-seededOpenAiSecret",
      "seeded-cookie-value",
      "https://panda.patrikmojzis.com/apps/open?token=pal_launch-token",
    ]) expect(persisted).toContain(sentinel);
    for (const sentinel of [
      "unsafe tool secret",
      base64Blob,
      "secret-key-value",
      "secret-token-value",
    ]) expect(persisted).not.toContain(sentinel);
    expect(persisted).toContain("[tool arg redacted]");
    expect(persisted).toContain("large_blob");
  });

  it("redacts unadorned prompt cache keys in both trace columns", async () => {
    const {pool, store} = await createStore();
    const rawSecret = "promptCacheKeySecretForTrace";
    const rawPromptCacheKey = `trace-cache:${rawSecret}`;

    await drainThread(createThread({
      runtime: new CompleteRuntime(),
      store,
      promptCacheKey: rawPromptCacheKey,
    }));

    const rows = await pool.query(`SELECT prompt_cache_key, request_json FROM "runtime"."model_call_traces"`);
    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0] as {prompt_cache_key: string | null; request_json: {promptCacheKey?: unknown}};
    expect(row.prompt_cache_key).toEqual(expect.stringMatching(PROMPT_CACHE_KEY_REDACTION_PATTERN));
    expect(row.prompt_cache_key).not.toContain(rawSecret);
    expect(row.prompt_cache_key).not.toContain(rawPromptCacheKey);
    expect(row.request_json.promptCacheKey).toBe(row.prompt_cache_key);
    expect(JSON.stringify(row.request_json)).not.toContain(rawSecret);
    expect(JSON.stringify(row.request_json)).not.toContain(rawPromptCacheKey);
  });

  it("purges expired traces and leaves unexpired traces in place", async () => {
    const {pool, store} = await createStore();
    await pool.query(`
      INSERT INTO "runtime"."model_call_traces" (
        id, provider, model, mode, status, started_at, finished_at, duration_ms, request_json, expires_at
      ) VALUES
        ('00000000-0000-0000-0000-000000000201', 'openai', 'gpt-test', 'complete', 'completed', '2040-01-01', '2040-01-01', 1, '{}'::jsonb, '2040-01-02'),
        ('00000000-0000-0000-0000-000000000202', 'openai', 'gpt-test', 'complete', 'completed', '2040-01-03', '2040-01-03', 1, '{}'::jsonb, '2040-01-10')
    `);

    await expect(store.purgeExpired(Date.parse("2040-01-05T00:00:00.000Z"))).resolves.toBe(1);

    const remaining = await store.listTraces();
    expect(remaining.data.map((trace) => trace.id)).toEqual(["00000000-0000-0000-0000-000000000202"]);
  });

  it("does not add model-call traces to session readonly SQL surfaces", async () => {
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
    expect(queries.join("\n")).not.toContain("model_call_traces");
  });
});
