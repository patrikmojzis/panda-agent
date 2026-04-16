import {describe, expect, it} from "vitest";

import {createThreadDefinition, DEFAULT_INFERENCE_PROJECTION,} from "../src/app/runtime/create-runtime.js";
import type {ThreadRecord} from "../src/domain/threads/runtime/types.js";

function createThread(
  overrides: Partial<ThreadRecord> = {},
): ThreadRecord {
  const now = Date.now();
  return {
    id: "thread-defaults",
    sessionId: "session-main",
    context: {
      agentKey: "panda",
      sessionId: "session-main",
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("createThreadDefinition inference projection defaults", () => {
  it("applies Panda's global inference projection by default", () => {
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

    expect(definition.inferenceProjection).toEqual(DEFAULT_INFERENCE_PROJECTION);
  });

  it("merges thread overrides on top of the Panda default", () => {
    const definition = createThreadDefinition({
      thread: createThread({
        inferenceProjection: {
          dropMessages: {
            preserveRecentUserTurns: 1,
          },
          dropThinking: {
            olderThanMs: 60_000,
          },
        },
      }),
      session: {
        id: "session-main",
        agentKey: "panda",
      },
      fallbackContext: {
        cwd: "/tmp/panda",
      },
    });

    expect(definition.inferenceProjection).toEqual({
      ...DEFAULT_INFERENCE_PROJECTION,
      dropMessages: {
        ...DEFAULT_INFERENCE_PROJECTION.dropMessages,
        preserveRecentUserTurns: 1,
      },
      dropThinking: {
        ...DEFAULT_INFERENCE_PROJECTION.dropThinking,
        olderThanMs: 60_000,
      },
    });
  });
});
