import {afterEach, describe, expect, it, vi} from "vitest";
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
import {PiAiRuntime} from "../src/integrations/providers/shared/runtime.js";
import {Agent, stringToUserMessage, Thread} from "../src/index.js";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-ai/compat")>();

  return {
    ...actual,
    completeSimple: mocks.completeSimple,
    streamSimple: mocks.streamSimple,
  };
});

describe("PiAiRuntime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    mocks.completeSimple.mockReset();
    mocks.streamSimple.mockReset();
  });

  it("adds a hard timeout signal to provider completions", async () => {
    vi.stubEnv("MODEL_TIMEOUT_MS", "10");
    mocks.completeSimple.mockResolvedValue({
      role: "assistant",
      content: [],
      timestamp: Date.now(),
      stopReason: "stop",
    });

    const runtime = new PiAiRuntime();
    await runtime.complete({
      providerName: "anthropic",
      modelId: "claude-opus-4-7",
      context: {messages: []},
    });

    const options = mocks.completeSimple.mock.calls[0]?.[2];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal.aborted).toBe(false);

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(options?.signal.aborted).toBe(true);
  });

  it("surfaces the internal hard timeout distinctly from caller abort", async () => {
    vi.stubEnv("MODEL_TIMEOUT_MS", "10");
    mocks.completeSimple.mockImplementation(async (_model, _context, options) => {
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), {once: true}));
      return {
        role: "assistant",
        content: [],
        timestamp: Date.now(),
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      };
    });

    const runtime = new PiAiRuntime();
    await expect(runtime.complete({
      providerName: "anthropic",
      modelId: "claude-opus-4-7",
      context: {messages: []},
    })).rejects.toThrow("Provider request timed out after 10ms");
  });

  it("lets Thread retry the real runtime hard-timeout seam as provider_timeout", async () => {
    vi.stubEnv("MODEL_TIMEOUT_MS", "10");
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.completeSimple
      .mockImplementationOnce(async (_model, _context, options) => {
        await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), {once: true}));
        return {
          role: "assistant",
          content: [],
          timestamp: Date.now(),
          stopReason: "aborted",
          errorMessage: "Request was aborted",
        };
      })
      .mockResolvedValueOnce({
        role: "assistant",
        content: [{type: "text", text: "recovered"}],
        timestamp: Date.now(),
        stopReason: "stop",
      });

    const thread = new Thread({
      agent: new Agent({name: "runtime-timeout", instructions: "Reply"}),
      model: "anthropic/claude-opus-4-7",
      messages: [stringToUserMessage("hi")],
      runtime: new PiAiRuntime(),
    });

    await expect(thread.runToCompletion()).resolves.toMatchObject({stopReason: "stop"});
    expect(mocks.completeSimple).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(
      "Retrying transient provider model call.",
      expect.objectContaining({failureKind: "provider_timeout"}),
    );
  });

  it("keeps caller abort signals wired through the timeout wrapper", async () => {
    mocks.completeSimple.mockResolvedValue({
      role: "assistant",
      content: [],
      timestamp: Date.now(),
      stopReason: "stop",
    });

    const controller = new AbortController();
    const runtime = new PiAiRuntime();
    await runtime.complete({
      providerName: "anthropic",
      modelId: "claude-opus-4-7",
      context: {messages: []},
      signal: controller.signal,
    });

    const options = mocks.completeSimple.mock.calls[0]?.[2];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal).not.toBe(controller.signal);
    expect(options?.signal.aborted).toBe(false);

    controller.abort(new Error("stop-now"));

    expect(options?.signal.aborted).toBe(true);
    expect(options?.signal.reason).toEqual(controller.signal.reason);
  });

  it("leaves a caller-aborted completion terminal", async () => {
    mocks.completeSimple.mockImplementation(async (_model, _context, options) => {
      await new Promise<void>((resolve) => options?.signal?.addEventListener("abort", () => resolve(), {once: true}));
      return {
        role: "assistant",
        content: [],
        timestamp: Date.now(),
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      };
    });

    const controller = new AbortController();
    const runtime = new PiAiRuntime();
    const completion = runtime.complete({
      providerName: "anthropic",
      modelId: "claude-opus-4-7",
      context: {messages: []},
      signal: controller.signal,
    });
    controller.abort();

    await expect(completion).resolves.toMatchObject({stopReason: "aborted"});
  });

  it("surfaces provider failures without wrapping them", async () => {
    const failure = Object.assign(new Error("429 Your account hit the rate limit."), {
      status: 429,
      requestID: "req_123",
      type: "rate_limit_error",
    });
    mocks.completeSimple.mockRejectedValue(failure);

    const runtime = new PiAiRuntime();

    await expect(runtime.complete({
      providerName: "anthropic-oauth",
      modelId: "claude-opus-4-7",
      context: {messages: []},
    })).rejects.toBe(failure);
  });

  it("does not apply the hard timeout to streaming requests", () => {
    mocks.streamSimple.mockReturnValue(createAssistantMessageEventStream());

    const controller = new AbortController();
    const runtime = new PiAiRuntime();
    runtime.stream({
      providerName: "anthropic",
      modelId: "claude-opus-4-7",
      context: {messages: []},
      signal: controller.signal,
    });

    const options = mocks.streamSimple.mock.calls[0]?.[2];
    expect(options?.signal).toBe(controller.signal);
  });
});
