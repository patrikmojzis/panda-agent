import { afterEach, describe, expect, it, vi } from "vitest";

import {
  Agent,
  compactThread,
  Thread,
  buildCompactSummaryMessage,
  createCompactBoundaryMessage,
  formatTranscriptForCompaction,
  PiAiRuntime,
  projectTranscriptForRun,
  splitTranscriptForCompaction,
  stringToUserMessage,
} from "../src/index.js";

function assistant(text: string) {
  return {
    role: "assistant" as const,
    content: [{ type: "text" as const, text }],
    api: "openai-responses" as const,
    provider: "openai" as const,
    model: "gpt-5.1",
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
        maxInputTokens: 350,
      },
      providerName: "openai",
      model: "gpt-5.1",
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
        maxInputTokens: 350,
      },
      transcript,
      providerName: "openai",
      model: "gpt-5.1",
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
        maxInputTokens: 350,
      },
      providerName: "openai",
      model: "gpt-5.1",
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
      maxInputTokens: 350,
    });

    const runInput = await thread.getRunInput();

    expect(runInput[0]).toEqual(compactSummary);
    expect(runInput).toContainEqual(messages[3]!);
  });
});
