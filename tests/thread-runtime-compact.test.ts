import { describe, expect, it } from "vitest";

import {
  Agent,
  Thread,
  buildCompactSummaryMessage,
  createCompactBoundaryMessage,
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
        origin: "input",
        source: "tui",
        message: stringToUserMessage("new follow-up"),
        createdAt: 6,
      },
    ]);

    expect(projected.map((record) => record.sequence)).toEqual([5, 3, 4, 6]);
    expect(projected[0]?.source).toBe("compact");
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
