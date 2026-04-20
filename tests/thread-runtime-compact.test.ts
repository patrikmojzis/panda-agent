import {afterEach, describe, expect, it, vi} from "vitest";
import type {AssistantMessage, ToolResultMessage} from "@mariozechner/pi-ai";
import {Agent, buildCompactSummaryMessage, PiAiRuntime, stringToUserMessage, Thread,} from "../src/index.js";
import {
    compactThread,
    createCompactBoundaryMessage,
    formatTranscriptForCompaction,
    projectTranscriptForRun,
    splitTranscriptForCompaction,
} from "../src/domain/threads/runtime/index.js";
import {buildReplaySegments,} from "../src/kernel/transcript/replay-segments.js";

const TEST_MODELS = vi.hoisted(() => ({
  window350: "openai/panda-test-window-350",
  window600: "openai/panda-test-window-600",
  operatingWindowByModel: new Map<string, number>([
    ["openai/panda-test-window-350", 350],
    ["openai/panda-test-window-600", 600],
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
const TEST_MODEL_WINDOW_600 = TEST_MODELS.window600;

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    model: "openai/gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };
}

function assistantWithToolCalls(...toolCallIds: string[]): AssistantMessage {
  return {
    role: "assistant",
    content: toolCallIds.map((id) => ({
      type: "toolCall" as const,
      id,
      name: "echo",
      arguments: {message: id},
    })),
    api: "openai-responses",
    model: "openai/gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0},
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function toolResult(toolCallId: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "echo",
    content: [{type: "text", text: toolCallId}],
    isError: false,
    timestamp: Date.now(),
  };
}

function buildCompactionTranscript() {
  return [
    {
      id: "1",
      threadId: "thread-compact",
      sequence: 1,
      origin: "input" as const,
      source: "tui",
      message: stringToUserMessage("old request " + "a".repeat(600)),
      createdAt: 1,
    },
    {
      id: "2",
      threadId: "thread-compact",
      sequence: 2,
      origin: "runtime" as const,
      source: "assistant",
      message: assistant("old reply"),
      createdAt: 2,
    },
    {
      id: "3",
      threadId: "thread-compact",
      sequence: 3,
      origin: "input" as const,
      source: "tui",
      message: stringToUserMessage("keep one"),
      createdAt: 3,
    },
    {
      id: "4",
      threadId: "thread-compact",
      sequence: 4,
      origin: "runtime" as const,
      source: "assistant",
      message: assistant("reply one"),
      createdAt: 4,
    },
    {
      id: "5",
      threadId: "thread-compact",
      sequence: 5,
      origin: "input" as const,
      source: "tui",
      message: stringToUserMessage("keep two"),
      createdAt: 5,
    },
    {
      id: "6",
      threadId: "thread-compact",
      sequence: 6,
      origin: "runtime" as const,
      source: "assistant",
      message: assistant("reply two"),
      createdAt: 6,
    },
    {
      id: "7",
      threadId: "thread-compact",
      sequence: 7,
      origin: "input" as const,
      source: "tui",
      message: stringToUserMessage("keep three"),
      createdAt: 7,
    },
    {
      id: "8",
      threadId: "thread-compact",
      sequence: 8,
      origin: "runtime" as const,
      source: "assistant",
      message: assistant("reply three"),
      createdAt: 8,
    },
    {
      id: "9",
      threadId: "thread-compact",
      sequence: 9,
      origin: "input" as const,
      source: "tui",
      message: stringToUserMessage("keep four"),
      createdAt: 9,
    },
    {
      id: "10",
      threadId: "thread-compact",
      sequence: 10,
      origin: "runtime" as const,
      source: "assistant",
      message: assistant("reply four"),
      createdAt: 10,
    },
    {
      id: "11",
      threadId: "thread-compact",
      sequence: 11,
      origin: "input" as const,
      source: "tui",
      message: stringToUserMessage("keep five"),
      createdAt: 11,
    },
    {
      id: "12",
      threadId: "thread-compact",
      sequence: 12,
      origin: "runtime" as const,
      source: "assistant",
      message: assistant("reply five"),
      createdAt: 12,
    },
    {
      id: "13",
      threadId: "thread-compact",
      sequence: 13,
      origin: "input" as const,
      source: "tui",
      message: stringToUserMessage("keep six"),
      createdAt: 13,
    },
    {
      id: "14",
      threadId: "thread-compact",
      sequence: 14,
      origin: "runtime" as const,
      source: "assistant",
      message: assistant("reply six"),
      createdAt: 14,
    },
  ];
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("thread compaction helpers", () => {
  it("splits older context from the preserved tail", () => {
    const transcript = [
      {
        id: "1",
        threadId: "thread-1",
        sequence: 1,
        origin: "input" as const,
        source: "tui",
        message: stringToUserMessage("old request"),
        createdAt: 1,
      },
      {
        id: "2",
        threadId: "thread-1",
        sequence: 2,
        origin: "runtime" as const,
        source: "assistant",
        message: assistant("old reply"),
        createdAt: 2,
      },
      {
        id: "3",
        threadId: "thread-1",
        sequence: 3,
        origin: "input" as const,
        source: "tui",
        message: stringToUserMessage("keep one"),
        createdAt: 3,
      },
      {
        id: "4",
        threadId: "thread-1",
        sequence: 4,
        origin: "runtime" as const,
        source: "assistant",
        message: assistant("reply one"),
        createdAt: 4,
      },
      {
        id: "5",
        threadId: "thread-1",
        sequence: 5,
        origin: "input" as const,
        source: "tui",
        message: stringToUserMessage("keep two"),
        createdAt: 5,
      },
      {
        id: "6",
        threadId: "thread-1",
        sequence: 6,
        origin: "runtime" as const,
        source: "assistant",
        message: assistant("reply two"),
        createdAt: 6,
      },
      {
        id: "7",
        threadId: "thread-1",
        sequence: 7,
        origin: "input" as const,
        source: "tui",
        message: stringToUserMessage("keep three"),
        createdAt: 7,
      },
      {
        id: "8",
        threadId: "thread-1",
        sequence: 8,
        origin: "runtime" as const,
        source: "assistant",
        message: assistant("reply three"),
        createdAt: 8,
      },
    ];

    const split = splitTranscriptForCompaction(transcript, 3);

    expect(split).not.toBeNull();
    expect(split?.summaryRecords.map((record) => record.sequence)).toEqual([1, 2]);
    expect(split?.preservedTail.map((record) => record.sequence)).toEqual([3, 4, 5, 6, 7, 8]);
    expect(split?.compactedUpToSequence).toBe(2);
  });

  it("projects the latest compact boundary plus later messages", () => {
    const boundaryMessage = createCompactBoundaryMessage("Intent:\n- continue");
    const projected = projectTranscriptForRun([
      {
        id: "1",
        threadId: "thread-2",
        sequence: 1,
        origin: "input",
        source: "tui",
        message: stringToUserMessage("old request"),
        createdAt: 1,
      },
      {
        id: "2",
        threadId: "thread-2",
        sequence: 2,
        origin: "runtime",
        source: "assistant",
        message: assistant("old reply"),
        createdAt: 2,
      },
      {
        id: "3",
        threadId: "thread-2",
        sequence: 3,
        origin: "input",
        source: "tui",
        message: stringToUserMessage("recent request"),
        createdAt: 3,
      },
      {
        id: "4",
        threadId: "thread-2",
        sequence: 4,
        origin: "runtime",
        source: "assistant",
        message: assistant("recent reply"),
        createdAt: 4,
      },
      {
        id: "5",
        threadId: "thread-2",
        sequence: 5,
        origin: "runtime",
        source: "compact",
        message: boundaryMessage,
        metadata: {
          kind: "compact_boundary",
          compactedUpToSequence: 2,
          preservedTailUserTurns: 3,
          trigger: "manual",
        },
        createdAt: 5,
      },
      {
        id: "6",
        threadId: "thread-2",
        sequence: 6,
        origin: "runtime",
        source: "compact",
        message: assistant("Auto-compaction failed, so Panda skipped this turn."),
        metadata: {
          kind: "compact_failure_notice",
          trigger: "auto",
          reason: "summary too large",
          consecutiveFailures: 1,
          cooldownUntil: null,
        },
        createdAt: 6,
      },
      {
        id: "7",
        threadId: "thread-2",
        sequence: 7,
        origin: "input",
        source: "tui",
        message: stringToUserMessage("new follow-up"),
        createdAt: 7,
      },
    ]);

    expect(projected.map((record) => record.sequence)).toEqual([5, 3, 4, 7]);
    expect(projected[0]?.source).toBe("compact");
  });

  it("reuses the shared helper for auto compaction boundaries", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const transcript = buildCompactionTranscript();
    const appendRuntimeMessage = vi.fn(async (_threadId: string, payload: any) => {
      const record = {
        id: "compact-1",
        threadId: "thread-compact",
        sequence: 9,
        origin: "runtime" as const,
        source: payload.source,
        message: payload.message,
        metadata: payload.metadata,
        createdAt: 9,
      };
      transcript.push(record);
      return record;
    });

    vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      assistant("<summary>\nIntent:\n- continue the recent work\n</summary>"),
    );

    const compacted = await compactThread({
      store: {
        loadTranscript: vi.fn(async () => transcript),
        appendRuntimeMessage,
      },
      thread: {
        id: "thread-compact",
      },
      model: TEST_MODEL_WINDOW_600,
      trigger: "auto",
    });

    expect(compacted).not.toBeNull();
    expect(appendRuntimeMessage).toHaveBeenCalledWith("thread-compact", expect.objectContaining({
      source: "compact",
      metadata: expect.objectContaining({
        kind: "compact_boundary",
        trigger: "auto",
        compactedUpToSequence: 2,
      }),
    }));
    expect(compacted?.tokensAfter).toBeLessThan(compacted?.tokensBefore ?? Number.POSITIVE_INFINITY);
  });

  it("reuses a caller-provided transcript instead of loading it again", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const transcript = buildCompactionTranscript();
    const loadTranscript = vi.fn(async () => {
      throw new Error("compactThread should reuse the provided transcript");
    });
    const appendRuntimeMessage = vi.fn(async (_threadId: string, payload: any) => {
      return {
        id: "compact-2",
        threadId: "thread-compact",
        sequence: 9,
        origin: "runtime" as const,
        source: payload.source,
        message: payload.message,
        metadata: payload.metadata,
        createdAt: 9,
      };
    });

    vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      assistant("<summary>\nIntent:\n- keep going\n</summary>"),
    );

    await expect(compactThread({
      store: {
        loadTranscript,
        appendRuntimeMessage,
      },
      thread: {
        id: "thread-compact",
      },
      transcript,
      model: TEST_MODEL_WINDOW_600,
      trigger: "auto",
    })).resolves.not.toBeNull();

    expect(loadTranscript).not.toHaveBeenCalled();
  });

  it("does not label compact failure notices as prior summaries", () => {
    const rendered = formatTranscriptForCompaction([
      {
        id: "1",
        threadId: "thread-compact",
        sequence: 1,
        origin: "runtime",
        source: "compact",
        message: assistant("Auto-compaction failed, so Panda skipped this turn."),
        metadata: {
          kind: "compact_failure_notice",
          trigger: "auto",
          reason: "summary too large",
          consecutiveFailures: 2,
          cooldownUntil: null,
        },
        createdAt: 1,
      },
    ]);

    expect(rendered).toContain("assistant source=compact");
    expect(rendered).not.toContain("prior_compact_summary");
  });

  it("rejects oversized shared-helper summaries", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key");

    const transcript = buildCompactionTranscript();
    const appendRuntimeMessage = vi.fn();
    vi.spyOn(PiAiRuntime.prototype, "complete").mockResolvedValue(
      assistant(`<summary>\nIntent:\n- ${"x".repeat(8_000)}\n</summary>`),
    );

    await expect(compactThread({
      store: {
        loadTranscript: vi.fn(async () => transcript),
        appendRuntimeMessage,
      },
      thread: {
        id: "thread-compact",
      },
      model: TEST_MODEL_WINDOW_600,
      trigger: "auto",
    })).rejects.toThrow("too large");

    expect(appendRuntimeMessage).not.toHaveBeenCalled();
  });
});

describe("Thread.getRunInput compact pinning", () => {
  it("keeps the compact summary anchor even when trimming to the tail", async () => {
    const compactSummary = stringToUserMessage(buildCompactSummaryMessage("Intent:\n- continue"));
    const messages = [
      compactSummary,
      stringToUserMessage("a".repeat(600)),
      stringToUserMessage("b".repeat(600)),
      stringToUserMessage("c".repeat(600)),
    ];

    const thread = new Thread({
      agent: new Agent({
        name: "compact-test",
        instructions: "Reply briefly",
      }),
      messages,
      model: TEST_MODEL_WINDOW_350,
    });

    const runInput = await thread.getRunInput();

    expect(runInput[0]).toEqual(compactSummary);
    expect(runInput).toContainEqual(messages[3]!);
  });

  it("groups tool exchanges atomically and records malformed runs without repairing them", () => {
    const segments = buildReplaySegments([
      stringToUserMessage("before"),
      assistantWithToolCalls("call-1", "call-2"),
      toolResult("call-1"),
      toolResult("call-1"),
      toolResult("call-x"),
      assistant("separator"),
      toolResult("orphan-1"),
      toolResult("orphan-2"),
      assistant("after"),
    ]);

    expect(segments).toMatchObject([
      {
        kind: "message",
        startIndex: 0,
        endIndex: 0,
        issues: [],
      },
      {
        kind: "tool_exchange",
        startIndex: 1,
        endIndex: 4,
        issues: ["duplicate_tool_result", "unexpected_tool_result", "missing_tool_results"],
      },
      {
        kind: "message",
        startIndex: 5,
        endIndex: 5,
        issues: [],
      },
      {
        kind: "orphan_tool_results",
        startIndex: 6,
        endIndex: 7,
        issues: ["orphan_tool_results"],
      },
      {
        kind: "message",
        startIndex: 8,
        endIndex: 8,
        issues: [],
      },
    ]);
  });

  it("drops an older tool exchange whole when only part of it would fit the replay window", async () => {
    const messages = [
      stringToUserMessage("before"),
      assistantWithToolCalls("call-old"),
      toolResult("call-old"),
      assistant("after tool"),
      stringToUserMessage("latest"),
    ];

    const thread = new Thread({
      agent: new Agent({
        name: "segment-trim-test",
        instructions: "Reply briefly",
      }),
      messages,
      model: TEST_MODEL_WINDOW_350,
      countTokens: (text) => {
        if (text === "call-old") {
          return 150;
        }

        if (text.includes("\"message\":\"call-old\"")) {
          return 150;
        }

        if (text === "after tool") {
          return 80;
        }

        if (text === "latest") {
          return 100;
        }

        if (text === "before") {
          return 40;
        }

        return 10;
      },
    });

    const runInput = await thread.getRunInput();

    expect(runInput).toEqual([
      messages[3],
      messages[4],
    ]);
  });

  it("keeps the newest oversized tool exchange whole for now", async () => {
    const messages = [
      stringToUserMessage("before"),
      assistantWithToolCalls("call-new"),
      toolResult("call-new"),
    ];

    const thread = new Thread({
      agent: new Agent({
        name: "segment-trim-test",
        instructions: "Reply briefly",
      }),
      messages,
      model: TEST_MODEL_WINDOW_350,
      countTokens: (text) => {
        if (text === "call-new") {
          return 120;
        }

        if (text.includes("\"message\":\"call-new\"")) {
          return 120;
        }

        if (text === "before") {
          return 40;
        }

        return 10;
      },
    });

    const runInput = await thread.getRunInput();

    expect(runInput).toEqual([
      messages[1],
      messages[2],
    ]);
  });

  it("warns on malformed replay segments and still keeps best-effort atomic groups", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const messages = [
      stringToUserMessage("before"),
      assistantWithToolCalls("call-1", "call-2"),
      toolResult("call-1"),
      toolResult("call-1"),
      toolResult("call-x"),
      assistant("after"),
    ];

    const thread = new Thread({
      agent: new Agent({
        name: "segment-warning-test",
        instructions: "Reply briefly",
      }),
      messages,
      model: TEST_MODEL_WINDOW_600,
    });

    const runInput = await thread.getRunInput();

    expect(runInput).toEqual(messages);
    expect(warnSpy).toHaveBeenCalledWith(
      "Replay transcript contained malformed tool segments; keeping best-effort atomic groups.",
      {
        issues: [{
          kind: "tool_exchange",
          startIndex: 1,
          endIndex: 4,
          issues: ["duplicate_tool_result", "unexpected_tool_result", "missing_tool_results"],
        }],
      },
    );
  });

  it("warns with transcript indexes when a compact summary is pinned", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const compactSummary = buildCompactSummaryMessage("summary");
    const messages = [
      compactSummary,
      stringToUserMessage("before"),
      assistantWithToolCalls("call-1", "call-2"),
      toolResult("call-1"),
      toolResult("call-1"),
      toolResult("call-x"),
      assistant("after"),
    ];

    const thread = new Thread({
      agent: new Agent({
        name: "segment-warning-pinned-test",
        instructions: "Reply briefly",
      }),
      messages,
      model: TEST_MODEL_WINDOW_600,
    });

    const runInput = await thread.getRunInput();

    expect(runInput).toEqual(messages);
    expect(warnSpy).toHaveBeenCalledWith(
      "Replay transcript contained malformed tool segments; keeping best-effort atomic groups.",
      {
        issues: [{
          kind: "tool_exchange",
          startIndex: 2,
          endIndex: 5,
          issues: ["duplicate_tool_result", "unexpected_tool_result", "missing_tool_results"],
        }],
      },
    );
  });
});
