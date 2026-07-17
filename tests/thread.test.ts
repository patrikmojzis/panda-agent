import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream} from "@earendil-works/pi-ai";

import {
    Agent,
    BackgroundJobWaitTool,
    BashTool,
    Hook,
    type LlmRuntime,
    type LlmRuntimeRequest,
    ProviderRuntimeError,
    type RunContext,
    RunPipeline,
    StreamingFailedError,
    stringToUserMessage,
    Thread,
    type ThreadRunEvent,
    Tool,
    type ToolResultPayload,
    z,
} from "../src/index.js";
import {runThreadStep, type ThreadStepResult} from "../src/kernel/agent/thread.js";
import {BackgroundToolJobService} from "../src/domain/threads/runtime/tool-job-service.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

class EchoTool extends Tool<typeof EchoTool.schema> {
  name = "echo";
  description = "Echo a message";
  static schema = z.object({
    message: z.string(),
  });
  schema = EchoTool.schema;

  async handle(
    args: z.output<typeof EchoTool.schema>,
    run: RunContext,
  ): Promise<{ echoed: string; turn: number }> {
    return {
      echoed: args.message,
      turn: run.turn,
    };
  }
}

class CountingTool extends Tool<typeof CountingTool.schema> {
  name = "counting";
  description = "Count side effects";
  static schema = z.object({});
  schema = CountingTool.schema;

  constructor(private readonly sideEffect: () => void) {
    super();
  }

  async handle(): Promise<{ counted: true }> {
    this.sideEffect();
    return { counted: true };
  }
}

class ProgressTool extends Tool<typeof ProgressTool.schema> {
  name = "progress";
  description = "Emit tool progress";
  static schema = z.object({
    message: z.string(),
  });
  schema = ProgressTool.schema;

  async handle(
    args: z.output<typeof ProgressTool.schema>,
    run: RunContext,
  ): Promise<{ done: string }> {
    run.emitToolProgress({
      phase: "started",
      message: args.message,
    });

    run.emitToolProgress({
      phase: "finished",
      message: args.message,
    });

    return {
      done: args.message,
    };
  }
}

class AdjustThinkingTool extends Tool<typeof AdjustThinkingTool.schema> {
  name = "adjust-thinking";
  description = "Adjust the live thinking level";
  static schema = z.object({
    level: z.enum(["off", "low", "medium", "high", "xhigh"]),
  });
  schema = AdjustThinkingTool.schema;

  async handle(
    args: z.output<typeof AdjustThinkingTool.schema>,
    run: RunContext,
  ): Promise<{ applied: string | null }> {
    run.setThinking(args.level === "off" ? undefined : args.level);
    return {
      applied: run.getThinking() ?? null,
    };
  }
}

class RichOutputTool extends Tool<typeof RichOutputTool.schema> {
  name = "rich-output";
  description = "Return text and image content";
  static schema = z.object({
    caption: z.string(),
  });
  schema = RichOutputTool.schema;

  async handle(
    args: z.output<typeof RichOutputTool.schema>,
    _run: RunContext,
  ): Promise<ToolResultPayload> {
    return {
      content: [
        { type: "text", text: args.caption },
        { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
      ],
      details: {
        kind: "preview",
      },
    };
  }
}

class RecordingHook extends Hook {
  constructor(private readonly events: string[]) {
    super();
  }

  override async onStart(): Promise<void> {
    this.events.push("start");
  }

  override async onEnd(): Promise<void> {
    this.events.push("end");
  }
}

class RecordingPipeline extends RunPipeline {
  constructor(private readonly events: string[]) {
    super();
  }

  override async preflight(): Promise<void> {
    this.events.push("preflight");
  }

  override async postflight(): Promise<void> {
    this.events.push("postflight");
  }
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

function createMockRuntime(...responses: AssistantMessage[]): LlmRuntime {
  return {
    complete: vi.fn().mockImplementation(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("No more mock responses queued");
      }

      return response as AssistantMessage;
    }),
    stream: vi.fn(() => {
      throw new Error("Streaming was not expected in this test");
    }),
  };
}

function message(text: string): AssistantMessage {
  return createAssistantMessage([{ type: "text", text }]);
}

function failingStream(
  error: Error,
  events: readonly AssistantMessageEvent[] = [],
): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
      throw error;
    },
    result: async () => {
      throw error;
    },
  } as AssistantMessageEventStream;
}

function completedStream(response: AssistantMessage): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {},
    result: async () => response,
  } as AssistantMessageEventStream;
}

function eventKind(event: ThreadRunEvent): string {
  return "type" in event ? event.type : event.role;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("Thread", () => {
  it("contextualizes terminated provider responses while preserving streaming failure compatibility", async () => {
    const terminated = createAssistantMessage([], {
      stopReason: "error",
      errorMessage: "terminated",
    });
    const runtime = createMockRuntime(terminated, terminated, terminated);

    const thread = new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Reply briefly",
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("hi")],
      runtime,
    });

    let caught: unknown;
    try {
      for await (const _output of thread.run()) {
        // Exhaust the generator.
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderRuntimeError);
    expect(caught).toBeInstanceOf(StreamingFailedError);
    const error = caught as ProviderRuntimeError;
    expect(error.providerName).toBe("openai");
    expect(error.modelId).toBe("gpt-4o-mini");
    expect(error.stopReason).toBe("error");
    expect(error.failureKind).toBe("provider_transport_terminated");
    expect(error.providerMessage).toBe("terminated");
    expect(error.message).toContain("provider=openai");
    expect(error.message).toContain("model=gpt-4o-mini");
    expect(error.message).toContain("failureKind=provider_transport_terminated");
    expect(error.message).toContain("detail=terminated");
  });

  it("wraps transport-like runtime throws with provider diagnostics", async () => {
    const runtime: LlmRuntime = {
      complete: vi.fn().mockRejectedValue(new Error("fetch failed")),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

    const thread = new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Reply briefly",
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("hi")],
      runtime,
    });

    await expect(async () => {
      for await (const _output of thread.run()) {
        // Exhaust the generator.
      }
    }).rejects.toMatchObject({
      providerName: "openai",
      modelId: "gpt-4o-mini",
      failureKind: "provider_transport_network",
      providerMessage: "fetch failed",
    });
  });

  it("classifies OpenAI/Codex server errors as retryable provider failures", async () => {
    const failure = Object.assign(new Error("OpenAI request failed"), {
      status: 501,
      requestID: "req_server_123",
      error: {
        message: "The server had an error while processing your request.",
        type: "server_error",
        code: "server_error",
      },
    });
    const runtime: LlmRuntime = {
      complete: vi.fn().mockRejectedValue(failure),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

    const thread = new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Reply briefly",
      }),
      model: "openai-codex/gpt-5.4",
      messages: [stringToUserMessage("hi")],
      runtime,
    });

    let caught: unknown;
    try {
      for await (const _output of thread.run()) {
        // Exhaust the generator.
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderRuntimeError);
    const error = caught as ProviderRuntimeError;
    expect(error).toMatchObject({
      providerName: "openai-codex",
      modelId: "gpt-5.4",
      failureKind: "provider_server_error",
      retryable: true,
      status: 501,
      requestId: "req_server_123",
      providerMessage: "The server had an error while processing your request.",
    });
    expect(error.message).toContain("failureKind=provider_server_error");
    expect(error.message).toContain("retryable=true");
    expect(error.message).toContain("status=501");
    expect(error.message).toContain("requestId=req_server_123");
    expect(error.message).toContain("detail=The server had an error while processing your request.");
  });

  it("extracts safe detail from raw Codex server_error payloads", async () => {
    const rawServerError = createAssistantMessage([], {
      stopReason: "error",
      errorMessage: JSON.stringify({
        error: {
          message: "The server had an error while processing your request. apiKey=sk-abcdefghijklmnopqrstuvwxyz987654321",
          type: "server_error",
          code: "server_error",
        },
        request_id: "req_payload_123",
        debug: {
          prompt: "NEVER_PERSIST_THIS_PROMPT",
        },
      }),
    });
    const runtime = createMockRuntime(rawServerError, rawServerError, rawServerError);

    const thread = new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Reply briefly",
      }),
      model: "openai-codex/gpt-5.4",
      messages: [stringToUserMessage("hi")],
      runtime,
    });

    let caught: unknown;
    try {
      for await (const _output of thread.run()) {
        // Exhaust the generator.
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderRuntimeError);
    const error = caught as ProviderRuntimeError;
    expect(error.failureKind).toBe("provider_server_error");
    expect(error.retryable).toBe(true);
    expect(error.requestId).toBe("req_payload_123");
    expect(error.providerMessage).toContain("apiKey=sk-abcdefghijklmnopqrstuvwxyz987654321");
    expect(error.message).toContain("retryable=true");
    expect(error.message).toContain("requestId=req_payload_123");
    expect(error.message).not.toContain("NEVER_PERSIST_THIS_PROMPT");
    expect(error.message).not.toContain('"debug"');
  });

  it("caps provider failure details without redacting token-shaped prose", async () => {
    const verboseFailure = createAssistantMessage([], {
      stopReason: "error",
      errorMessage: `fetch failed Bearer abcdefghijklmnopqrstuvwxyz987654321 apiKey=sk-abcdefghijklmnopqrstuvwxyz987654321 ${"x".repeat(1_000)}`,
    });
    const runtime = createMockRuntime(verboseFailure, verboseFailure, verboseFailure);

    const thread = new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Reply briefly",
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("hi")],
      runtime,
    });

    let caught: unknown;
    try {
      for await (const _output of thread.run()) {
        // Exhaust the generator.
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderRuntimeError);
    const error = caught as ProviderRuntimeError;
    expect(error.failureKind).toBe("provider_transport_network");
    expect(error.providerMessage).toContain("Bearer abcdefghijklmnopqrstuvwxyz987654321");
    expect(error.providerMessage).toContain("apiKey=sk-abcdefghijklmnopqrstuvwxyz987654321");
    expect(error.providerMessage).toContain("[truncated");
    expect(error.message.length).toBeLessThan(1_100);
  });

  it.each([
    ["WebSocket connection closed unexpectedly", "provider_transport_network"],
    ["Provider stream terminated", "provider_transport_terminated"],
    ["Provider request timed out", "provider_timeout"],
    ["The model is overloaded, try again later", "provider_server_error"],
    ["You can retry your request", "provider_server_error"],
  ])("retries transient provider failures before exposing an assistant result: %s", async (detail, failureKind) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error(detail);
    const requestObjects: LlmRuntimeRequest[] = [];
    const complete = vi.fn(async (request: LlmRuntimeRequest) => {
      requestObjects.push(request);
      if (requestObjects.length === 1) {
        throw failure;
      }
      return message("recovered");
    });
    const thread = new Thread({
      agent: new Agent({name: "retry", instructions: "Reply briefly"}),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("hi")],
      runtime: {
        complete,
        stream: vi.fn(() => { throw new Error("stream not expected"); }),
      },
      context: {runId: "run-retry", threadId: "thread-retry"},
    });

    const outcome = thread.runToCompletion().then(
      (value) => ({value}),
      (error: unknown) => ({error}),
    );
    await vi.advanceTimersByTimeAsync(500);

    await expect(outcome).resolves.toEqual({value: expect.objectContaining({role: "assistant"})});
    expect(complete).toHaveBeenCalledTimes(2);
    expect(requestObjects[1]).toBe(requestObjects[0]);
    expect(warning).toHaveBeenCalledWith(
      "Retrying transient provider model call.",
      expect.objectContaining({
        failureKind,
        attempt: 2,
        maxAttempts: 3,
        delayMs: 500,
        runId: "run-retry",
        threadId: "thread-retry",
      }),
    );
  });

  it("retries every structured 5xx status", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const status of [500, 505, 599]) {
      const failure = Object.assign(new Error("provider rejected request"), {status});
      const complete = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(message("ok"));
      const thread = new Thread({
        agent: new Agent({name: "retry-5xx", instructions: "Reply briefly"}),
        model: "openai/gpt-4o-mini",
        messages: [stringToUserMessage("hi")],
        runtime: {complete, stream: vi.fn(() => { throw new Error("stream not expected"); })},
      });

      const outcome = thread.runToCompletion().then(
        (value) => ({value}),
        (error: unknown) => ({error}),
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(await outcome).toEqual({value: expect.objectContaining({role: "assistant"})});
      expect(complete).toHaveBeenCalledTimes(2);
    }
  });

  it.each([
    ["400", Object.assign(new Error("try again later"), {status: 400})],
    ["408", Object.assign(new Error("request timed out"), {status: 408})],
    ["429", Object.assign(new Error("try again later"), {status: 429})],
    ["499", Object.assign(new Error("server error"), {status: 499})],
    ["raw 408", new Error("HTTP 408 request timeout")],
    ["rate limit", new Error("rate limit exceeded, try again later")],
    ["retryable ProviderRuntimeError with 4xx", new ProviderRuntimeError("retryable", {
      providerName: "openai",
      modelId: "gpt-4o-mini",
      status: 429,
      failureKind: "provider_server_error",
      retryable: true,
    })],
    ["auth", new Error("authentication failed: invalid api key")],
    ["permission", new Error("permission denied")],
    ["invalid input", new Error("invalid request argument")],
    ["context", new Error("context window token limit exceeded")],
    ["abort", Object.assign(new Error("The operation was aborted"), {name: "AbortError"})],
    ["Unicode", new Error("unsupported Unicode escape sequence")],
    ["environment", new Error("execution environment container exited")],
  ])("does not retry denied provider failures: %s", async (_label, failure) => {
    const complete = vi.fn().mockRejectedValue(failure);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const thread = new Thread({
      agent: new Agent({name: "no-retry", instructions: "Reply briefly"}),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("hi")],
      runtime: {complete, stream: vi.fn(() => { throw new Error("stream not expected"); })},
    });

    await expect(thread.runToCompletion()).rejects.toThrow();
    expect(complete).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalledWith(
      "Retrying transient provider model call.",
      expect.anything(),
    );
  });

  it.each([
    [0, 500, 1_000],
    [0.999_999, 999, 1_999],
  ])("bounds equal-jitter backoff and exhaustion metadata with random=%s", async (random, firstDelay, secondDelay) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(random);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error("fetch failed");
    const requests: LlmRuntimeRequest[] = [];
    const callTimes: number[] = [];
    const complete = vi.fn(async (request: LlmRuntimeRequest) => {
      requests.push(request);
      callTimes.push(Date.now());
      throw failure;
    });
    const events: string[] = [];
    const thread = new Thread({
      agent: new Agent({name: "bounded-retry", instructions: "Reply briefly"}),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("hi")],
      runtime: {complete, stream: vi.fn(() => { throw new Error("stream not expected"); })},
      hooks: [new RecordingHook(events)],
      runPipelines: [new RecordingPipeline(events)],
    });

    const outcome = thread.runToCompletion().then(
      (value) => ({value}),
      (error: unknown) => ({error}),
    );
    await vi.advanceTimersByTimeAsync(firstDelay - 1);
    expect(complete).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(complete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(secondDelay - 1);
    expect(complete).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);

    const result = await outcome;
    expect(result.error).toBeInstanceOf(ProviderRuntimeError);
    expect((result.error as Error).message).toContain("attempts=3; maxAttempts=3; retryExhausted=true");
    expect(complete).toHaveBeenCalledTimes(3);
    expect(callTimes.map((time) => time - callTimes[0]!)).toEqual([
      0,
      firstDelay,
      firstDelay + secondDelay,
    ]);
    expect(requests[1]).toBe(requests[0]);
    expect(requests[2]).toBe(requests[0]);
    expect(events).toEqual(["preflight", "start"]);
    expect(warning).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warning.mock.calls)).not.toContain("fetch failed");
  });

  it("aborts a pending retry delay without launching another provider call", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const controller = new AbortController();
    const complete = vi.fn().mockRejectedValue(new Error("fetch failed"));
    const thread = new Thread({
      agent: new Agent({name: "abort-retry", instructions: "Reply briefly"}),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("hi")],
      runtime: {complete, stream: vi.fn(() => { throw new Error("stream not expected"); })},
      signal: controller.signal,
    });

    const outcome = thread.runToCompletion().then(
      (value) => ({value}),
      (error: unknown) => ({error}),
    );
    await vi.advanceTimersByTimeAsync(100);
    const abortReason = new Error("caller cancelled");
    controller.abort(abortReason);

    expect((await outcome).error).toBe(abortReason);
    await vi.runAllTimersAsync();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("retries only the model call after a completed tool side effect", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const sideEffect = vi.fn();
    const requests: LlmRuntimeRequest[] = [];
    const complete = vi.fn(async (request: LlmRuntimeRequest) => {
      requests.push(request);
      if (requests.length === 1) {
        return createAssistantMessage([{
          type: "toolCall",
          id: "call_count",
          name: "counting",
          arguments: {},
        }]);
      }
      if (requests.length === 2) {
        throw new Error("socket closed");
      }
      return message("done");
    });
    const events: string[] = [];
    const thread = new Thread({
      agent: new Agent({
        name: "tool-retry",
        instructions: "Use tools",
        tools: [new CountingTool(sideEffect)],
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("count")],
      runtime: {complete, stream: vi.fn(() => { throw new Error("stream not expected"); })},
      hooks: [new RecordingHook(events)],
      runPipelines: [new RecordingPipeline(events)],
    });

    const outcome = thread.runToCompletion().then(
      (value) => ({value}),
      (error: unknown) => ({error}),
    );
    await vi.advanceTimersByTimeAsync(500);

    expect((await outcome).error).toBeUndefined();
    expect(sideEffect).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toBe(requests[1]);
    expect(requests[1]?.context.messages).toEqual(requests[2]?.context.messages);
    expect(requests[1]?.context.messages.filter((entry) => entry.role === "toolResult")).toHaveLength(1);
    expect(thread.messages.filter((entry) => entry.role === "assistant")).toHaveLength(2);
    expect(thread.messages.filter((entry) => entry.role === "toolResult")).toHaveLength(1);
    expect(events).toEqual([
      "preflight", "start", "end", "postflight",
      "preflight", "start", "end", "postflight",
    ]);
  });

  it("retries a zero-yield stream failure but fails closed after a yielded tool call", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const partial = createAssistantMessage([{
      type: "toolCall",
      id: "partial_call",
      name: "counting",
      arguments: {},
    }]);
    const sideEffect = vi.fn();
    const stream = vi.fn()
      .mockReturnValueOnce(failingStream(new Error("fetch failed")))
      .mockReturnValueOnce(completedStream(message("recovered")))
      .mockReturnValueOnce(failingStream(new Error("socket closed"), [{
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: partial.content[0] as Extract<AssistantMessage["content"][number], {type: "toolCall"}>,
        partial,
      }]));
    const thread = new Thread({
      agent: new Agent({
        name: "stream-retry",
        instructions: "Use tools",
        tools: [new CountingTool(sideEffect)],
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("stream")],
      runtime: {complete: vi.fn(), stream},
    });

    const firstEvents: ThreadRunEvent[] = [];
    const firstRun = (async () => {
      for await (const event of thread.stream()) {
        firstEvents.push(event as ThreadRunEvent);
      }
    })().then(
      () => ({ok: true}),
      (error: unknown) => ({error}),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(await firstRun).toEqual({ok: true});
    expect(stream).toHaveBeenCalledTimes(2);

    thread.addMessage(stringToUserMessage("stream again"));
    const secondEvents: ThreadRunEvent[] = [];
    await expect(async () => {
      for await (const event of thread.stream()) {
        secondEvents.push(event as ThreadRunEvent);
      }
    }).rejects.toMatchObject({failureKind: "provider_transport_network"});
    expect(secondEvents).toHaveLength(1);
    expect(stream).toHaveBeenCalledTimes(3);
    expect(sideEffect).not.toHaveBeenCalled();
  });

  it("runs recursive tool calls and hook/pipeline callbacks", async () => {
    const events: string[] = [];
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "echo",
          arguments: { message: "hi" },
        },
      ]),
      message("done"),
    );

    const thread = new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Use tools when needed",
        tools: [new EchoTool()],
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("call the tool")],
      runtime,
      hooks: [new RecordingHook(events)],
      runPipelines: [new RecordingPipeline(events)],
    });

    const outputs: ThreadRunEvent[] = [];
    for await (const output of thread.run()) {
      outputs.push(output);
    }

    expect(outputs.map(eventKind)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(outputs[1]).toMatchObject({
      role: "toolResult",
      toolName: "echo",
      details: {
        echoed: "hi",
        turn: 1,
      },
    });
    expect(events).toEqual([
      "preflight",
      "start",
      "end",
      "postflight",
      "preflight",
      "start",
      "end",
      "postflight",
    ]);
  });

  it("can start background bash, do more work, then wait on it", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "panda-thread-bg-"));
    try {
      const store = new TestThreadRuntimeStore();
      await store.createThread({
        id: "thread-bg",
        sessionId: "session-thread-bg",
      });
      const service = new BackgroundToolJobService({ store });
      let turn = 0;
      const runtime: LlmRuntime = {
        complete: vi.fn().mockImplementation(async () => {
          turn += 1;
          if (turn === 1) {
            return createAssistantMessage([
              {
                type: "toolCall",
                id: "call_bg",
                name: "bash",
                arguments: {
                  command: "sleep 0.2 && printf hello",
                  background: true,
                },
              },
            ]);
          }

          if (turn === 2) {
            return createAssistantMessage([
              {
                type: "toolCall",
                id: "call_echo",
                name: "echo",
                arguments: { message: "other work" },
              },
            ]);
          }

          if (turn === 3) {
            const jobId = (await store.listToolJobs("thread-bg"))[0]?.id ?? "";

            return createAssistantMessage([
              {
                type: "toolCall",
                id: "call_wait",
                name: "background_job_wait",
                arguments: {
                  jobId,
                  timeoutMs: 1_000,
                },
              },
            ]);
          }

          return message("done");
        }),
        stream: vi.fn(() => {
          throw new Error("Streaming was not expected in this test");
        }),
      };

      const thread = new Thread({
        agent: new Agent({
          name: "bg-thread-agent",
          instructions: "Use the tools.",
          tools: [
            new BashTool({
              outputDirectory: path.join(workspace, "tool-results"),
              jobService: service,
            }),
            new BackgroundJobWaitTool({ service }),
            new EchoTool(),
          ],
        }),
        messages: [stringToUserMessage("do the job")],
        runtime,
        context: {
          threadId: "thread-bg",
          cwd: workspace,
          shell: {
            cwd: workspace,
            env: {},
          },
        },
      });

      const outputs: ThreadRunEvent[] = [];
      for await (const output of thread.run()) {
        outputs.push(output);
      }

      expect(outputs.map(eventKind)).toEqual([
        "assistant",
        "toolResult",
        "assistant",
        "toolResult",
        "assistant",
        "toolResult",
        "assistant",
      ]);
      expect(outputs[1]).toMatchObject({
        role: "toolResult",
        toolName: "bash",
        details: {
          status: "running",
        },
      });
      expect(outputs[3]).toMatchObject({
        role: "toolResult",
        toolName: "echo",
        details: {
          echoed: "other work",
        },
      });
      expect(outputs[5]).toMatchObject({
        role: "toolResult",
        toolName: "background_job_wait",
        details: {
          status: "completed",
          stdout: "hello",
        },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("parses structured output with zod", async () => {
    const runtime = createMockRuntime(message(JSON.stringify({ answer: "42" })));

    const thread = new Thread({
      agent: new Agent({
        name: "structured",
        instructions: "Return JSON",
        outputSchema: z.object({
          answer: z.string(),
        }),
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("What is the answer?")],
      runtime,
    });

    await expect(thread.runToCompletion()).resolves.toEqual({ answer: "42" });
  });

  it("parses structured output split across assistant text blocks", async () => {
    const runtime = createMockRuntime(createAssistantMessage([
      { type: "text", text: "\n { \"answer\"" },
      { type: "text", text: ": \"42\" } \n" },
    ]));

    const thread = new Thread({
      agent: new Agent({
        name: "structured",
        instructions: "Return JSON",
        outputSchema: z.object({
          answer: z.string(),
        }),
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("What is the answer?")],
      runtime,
    });

    await expect(thread.runToCompletion()).resolves.toEqual({ answer: "42" });
  });

  it("uses thread execution settings for runtime requests", async () => {
    const complete = vi.fn().mockResolvedValue(message("done"));
    const runtime: LlmRuntime = {
      complete,
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

    const thread = new Thread({
      agent: new Agent({
        name: "runtime-config",
        instructions: "Be helpful",
      }),
      model: "openai/gpt-4o-mini",
      temperature: 0.25,
      thinking: "medium",
      messages: [stringToUserMessage("hello")],
      runtime,
    });

    await thread.runToCompletion();

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "gpt-4o-mini",
      providerName: "openai",
      temperature: 0.25,
      thinking: "medium",
    }));
  });

  it("uses updated thinking on the next request after a tool changes it", async () => {
    const requests: LlmRuntimeRequest[] = [];
    const runtime: LlmRuntime = {
      complete: vi.fn().mockImplementation(async (request: LlmRuntimeRequest) => {
        requests.push(request);
        if (requests.length === 1) {
          return createAssistantMessage([
            {
              type: "toolCall",
              id: "call_1",
              name: "adjust-thinking",
              arguments: { level: "high" },
            },
          ]);
        }

        return message("done");
      }),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

    const thread = new Thread({
      agent: new Agent({
        name: "adaptive-thinking-agent",
        instructions: "Adjust thinking when needed.",
        tools: [new AdjustThinkingTool()],
      }),
      model: "openai/gpt-4o-mini",
      thinking: "low",
      messages: [stringToUserMessage("hello")],
      runtime,
    });

    await thread.runToCompletion();

    expect(requests.map((request) => request.thinking ?? null)).toEqual(["low", "high"]);
  });

  it("clears live thinking on the next request after a tool turns it off", async () => {
    const requests: LlmRuntimeRequest[] = [];
    const runtime: LlmRuntime = {
      complete: vi.fn().mockImplementation(async (request: LlmRuntimeRequest) => {
        requests.push(request);
        if (requests.length === 1) {
          return createAssistantMessage([
            {
              type: "toolCall",
              id: "call_1",
              name: "adjust-thinking",
              arguments: { level: "off" },
            },
          ]);
        }

        return message("done");
      }),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

    const thread = new Thread({
      agent: new Agent({
        name: "adaptive-thinking-agent",
        instructions: "Adjust thinking when needed.",
        tools: [new AdjustThinkingTool()],
      }),
      model: "openai/gpt-4o-mini",
      thinking: "medium",
      messages: [stringToUserMessage("hello")],
      runtime,
    });

    await thread.runToCompletion();

    expect(requests.map((request) => request.thinking ?? null)).toEqual(["medium", null]);
  });

  it("resets ephemeral thinking before the next top-level run on a reused thread", async () => {
    const requests: LlmRuntimeRequest[] = [];
    const runtime: LlmRuntime = {
      complete: vi.fn().mockImplementation(async (request: LlmRuntimeRequest) => {
        requests.push(request);
        if (requests.length === 1) {
          return createAssistantMessage([
            {
              type: "toolCall",
              id: "call_1",
              name: "adjust-thinking",
              arguments: { level: "high" },
            },
          ]);
        }

        return message("done");
      }),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

    const thread = new Thread({
      agent: new Agent({
        name: "adaptive-thinking-agent",
        instructions: "Adjust thinking when needed.",
        tools: [new AdjustThinkingTool()],
      }),
      model: "openai/gpt-4o-mini",
      thinking: "low",
      messages: [stringToUserMessage("hello")],
      runtime,
    });

    await thread.runToCompletion();
    thread.addMessage(stringToUserMessage("hello again"));
    await thread.runToCompletion();

    expect(requests.map((request) => request.thinking ?? null)).toEqual(["low", "high", "low"]);
  });

  it("returns resume state from runStep so a later boundary can continue with live thinking", async () => {
    const requests: Array<{ thinking?: string }> = [];
    const runtime: LlmRuntime = {
      complete: vi.fn().mockImplementation(async (request: { thinking?: string }) => {
        requests.push(request);
        if (requests.length === 1) {
          return createAssistantMessage([
            {
              type: "toolCall",
              id: "call_1",
              name: "adjust-thinking",
              arguments: { level: "high" },
            },
          ]);
        }

        return message("done");
      }),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test");
      }),
    };

    const firstThread = new Thread({
      agent: new Agent({
        name: "adaptive-thinking-agent",
        instructions: "Adjust thinking when needed.",
        tools: [new AdjustThinkingTool()],
      }),
      model: "openai/gpt-4o-mini",
      thinking: "low",
      messages: [stringToUserMessage("hello")],
      runtime,
    });

    const firstStep = runThreadStep(firstThread);
    let stepResult!: ThreadStepResult;
    while (true) {
      const next = await firstStep.next();
      if (next.done) {
        stepResult = next.value;
        break;
      }
    }

    expect(stepResult).toMatchObject({
      needsAnotherTurn: true,
      resumeState: {
        turnCount: 1,
        thinking: "high",
      },
    });

    const resumedThread = new Thread({
      agent: new Agent({
        name: "adaptive-thinking-agent",
        instructions: "Adjust thinking when needed.",
        tools: [new AdjustThinkingTool()],
      }),
      model: "openai/gpt-4o-mini",
      thinking: "low",
      messages: firstThread.messages,
      runtime,
      resumeState: stepResult.resumeState,
    });

    await resumedThread.runToCompletion();

    expect(requests.map((request) => request.thinking ?? null)).toEqual(["low", "high"]);
  });

  it("streams tool progress events before the final tool result", async () => {
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "progress",
          arguments: { message: "working" },
        },
      ]),
      message("done"),
    );

    const thread = new Thread({
      agent: new Agent({
        name: "progress-agent",
        instructions: "Use the progress tool",
        tools: [new ProgressTool()],
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("show progress")],
      runtime,
    });

    const outputs: ThreadRunEvent[] = [];
    for await (const output of thread.run()) {
      outputs.push(output);
    }

    expect(outputs.map(eventKind)).toEqual([
      "assistant",
      "tool_progress",
      "tool_progress",
      "toolResult",
      "assistant",
    ]);
    expect(outputs[1]).toMatchObject({
      type: "tool_progress",
      toolName: "progress",
    });
  });

  it("preserves rich tool result content for follow-up model turns", async () => {
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "rich-output",
          arguments: { caption: "Image attached" },
        },
      ]),
      message("done"),
    );

    const thread = new Thread({
      agent: new Agent({
        name: "rich-output-agent",
        instructions: "Use the tool",
        tools: [new RichOutputTool()],
      }),
      model: "openai/gpt-4o-mini",
      messages: [stringToUserMessage("show me the image")],
      runtime,
    });

    const outputs: ThreadRunEvent[] = [];
    for await (const output of thread.run()) {
      outputs.push(output);
    }

    expect(outputs[1]).toMatchObject({
      role: "toolResult",
      toolName: "rich-output",
      content: [
        { type: "text", text: "Image attached" },
        { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
      ],
      details: {
        kind: "preview",
      },
    });
  });
});
