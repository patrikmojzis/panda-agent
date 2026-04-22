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
