import {afterEach, describe, expect, it, vi} from "vitest";
import {PiAiRuntime} from "../src/integrations/providers/shared/runtime.js";

const mocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  streamSimple: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mariozechner/pi-ai")>();

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
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
      context: [] as never,
    });

    const options = mocks.completeSimple.mock.calls[0]?.[2];
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal.aborted).toBe(false);

    await new Promise((resolve) => {
      setTimeout(resolve, 25);
    });

    expect(options?.signal.aborted).toBe(true);
    expect(stdoutWrite).toHaveBeenCalled();
  });

  it("keeps caller abort signals wired through the timeout wrapper", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
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
      context: [] as never,
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

  it("logs provider request lifecycle events with request metadata", async () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.completeSimple.mockResolvedValue({
      role: "assistant",
      content: [],
      timestamp: Date.now(),
      stopReason: "stop",
      responseId: "resp_123",
    });

    const runtime = new PiAiRuntime();
    await runtime.complete({
      providerName: "anthropic-oauth",
      modelId: "claude-opus-4-7",
      context: [] as never,
      metadata: {
        runId: "run-1",
        threadId: "thread-1",
        agentKey: "luna",
        turn: 2,
      },
    });

    const payloads = stdoutWrite.mock.calls
      .map(([chunk]) => String(chunk).trim())
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk) as Record<string, unknown>);

    expect(payloads.map((entry) => entry.event)).toContain("provider_request_started");
    expect(payloads.map((entry) => entry.event)).toContain("provider_request_completed");
    expect(payloads.some((entry) =>
      entry.event === "provider_request_started"
      && entry.provider === "anthropic-oauth"
      && entry.model === "claude-opus-4-7"
      && entry.runId === "run-1"
      && entry.threadId === "thread-1"
      && entry.agentKey === "luna"
      && entry.turn === 2
    )).toBe(true);
  });

  it("wraps provider rate limit failures into readable surfaced errors", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    mocks.completeSimple.mockRejectedValue(Object.assign(new Error("429 Your account hit the rate limit."), {
      status: 429,
      requestID: "req_123",
      type: "rate_limit_error",
    }));

    const runtime = new PiAiRuntime();

    await expect(runtime.complete({
      providerName: "anthropic-oauth",
      modelId: "claude-opus-4-7",
      context: [] as never,
    })).rejects.toThrow(
      "Provider rate limit or quota exceeded for anthropic-oauth/claude-opus-4-7 (status 429, request id req_123): Your account hit the rate limit.",
    );
  });

  it("does not apply the hard timeout to streaming requests", () => {
    mocks.streamSimple.mockReturnValue({} as never);

    const controller = new AbortController();
    const runtime = new PiAiRuntime();
    runtime.stream({
      providerName: "anthropic",
      modelId: "claude-opus-4-7",
      context: [] as never,
      signal: controller.signal,
    });

    const options = mocks.streamSimple.mock.calls[0]?.[2];
    expect(options?.signal).toBe(controller.signal);
  });
});
