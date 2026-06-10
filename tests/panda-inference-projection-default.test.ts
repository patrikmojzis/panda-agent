import {describe, expect, it} from "vitest";

import {createThreadDefinition, DEFAULT_INFERENCE_PROJECTION,} from "../src/app/runtime/create-runtime.js";
import {projectTranscriptForInference} from "../src/domain/threads/runtime/index.js";
import type {ThreadMessageRecord, ThreadRecord} from "../src/domain/threads/runtime/types.js";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function createThread(
  overrides: Partial<ThreadRecord> = {},
): ThreadRecord {
  const now = Date.now();
  return {
    id: "thread-defaults",
    sessionId: "session-main",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createTranscriptRecord(
  sequence: number,
  content: string,
  createdAt: number,
): ThreadMessageRecord {
  return {
    id: `record-${sequence}`,
    threadId: "thread-defaults",
    sequence,
    origin: "input",
    source: "tui",
    message: {
      role: "user",
      content,
    },
    createdAt,
  };
}

describe("createThreadDefinition inference projection defaults", () => {
  it("applies Panda's global inference projection by default without age-dropping messages", () => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-main",
        agentKey: "panda",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
    });

    expect(DEFAULT_INFERENCE_PROJECTION).toEqual({
      dropToolCalls: {
        olderThanMs: 4 * HOUR_MS,
        preserveRecentUserTurns: 20,
      },
      dropThinking: {
        olderThanMs: 4 * HOUR_MS,
        preserveRecentUserTurns: 10,
      },
      dropImages: {
        olderThanMs: 8 * HOUR_MS,
        preserveRecentUserTurns: 20,
      },
    });
    expect(definition.inferenceProjection).toEqual(DEFAULT_INFERENCE_PROJECTION);
    expect(DEFAULT_INFERENCE_PROJECTION).not.toHaveProperty("dropMessages");
    expect(definition.inferenceProjection?.dropMessages).toBeUndefined();
  });

  it("keeps old text messages when only the Panda default projection is active", () => {
    const now = 5 * DAY_MS;
    const transcript = [
      createTranscriptRecord(1, "older than the former two-day cutoff", now - (3 * DAY_MS)),
      createTranscriptRecord(2, "recent request", now - HOUR_MS),
    ];

    const projected = projectTranscriptForInference(
      transcript,
      DEFAULT_INFERENCE_PROJECTION,
      now,
    );

    expect(projected.map((record) => record.sequence)).toEqual([1, 2]);
  });

  it("merges session runtime overrides on top of the Panda default", () => {
    const definition = createThreadDefinition({
      thread: createThread(),
      session: {
        id: "session-main",
        agentKey: "panda",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
      runtimeConfig: {
        sessionId: "session-main",
        thinkingConfigured: false,
        inferenceProjection: {
          dropMessages: {
            olderThanMs: 60_000,
            preserveRecentUserTurns: 1,
          },
          dropThinking: {
            olderThanMs: 60_000,
          },
        },
      },
    });

    expect(definition.inferenceProjection).toEqual({
      ...DEFAULT_INFERENCE_PROJECTION,
      dropMessages: {
        olderThanMs: 60_000,
        preserveRecentUserTurns: 1,
      },
      dropThinking: {
        ...DEFAULT_INFERENCE_PROJECTION.dropThinking,
        olderThanMs: 60_000,
      },
    });

    const projected = projectTranscriptForInference([
      createTranscriptRecord(1, "old request", 0),
      createTranscriptRecord(2, "protected recent turn", 90_000),
    ], definition.inferenceProjection, 120_000);

    expect(projected.map((record) => record.sequence)).toEqual([2]);
  });
});
