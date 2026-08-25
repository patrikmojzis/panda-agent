import {describe, expect, it, vi} from "vitest";

import {stringToUserMessage} from "../src/kernel/agent/helpers/input.js";
import {loadStoredThreadSnapshot} from "../src/ui/shared/stored-thread.js";

function message(sequence: number) {
  return {
    id: `message-${sequence}`,
    threadId: "thread-forward-refresh",
    sequence,
    origin: "runtime" as const,
    source: "assistant",
    message: stringToUserMessage(`message ${sequence}`),
    createdAt: sequence,
  };
}

describe("stored thread snapshots", () => {
  it("seeks forward through every new page without rereading old history", async () => {
    const listTranscriptPage = vi.fn(async (_threadId: string, options: {afterSequence?: number}) => {
      if (options.afterSequence === 2) {
        return {
          records: [message(3), message(4)],
          nextAfterSequence: 4,
        };
      }
      return {records: [message(5)]};
    });
    const store = {
      getThread: vi.fn(async () => ({
        id: "thread-forward-refresh",
        sessionId: "session-forward-refresh",
        createdAt: 1,
        updatedAt: 2,
      })),
      listTranscriptPage,
      getLatestRun: vi.fn(async () => null),
    };

    const snapshot = await loadStoredThreadSnapshot({
      store,
      threadId: "thread-forward-refresh",
      afterSequence: 2,
    });

    expect(snapshot.transcript.map((record) => record.sequence)).toEqual([3, 4, 5]);
    expect(listTranscriptPage).toHaveBeenNthCalledWith(1, "thread-forward-refresh", {
      afterSequence: 2,
      limit: 500,
    });
    expect(listTranscriptPage).toHaveBeenNthCalledWith(2, "thread-forward-refresh", {
      afterSequence: 4,
      limit: 500,
    });
  });

  it("loads only the latest run state for refresh", async () => {
    const latestRun = {
      id: "run-latest",
      threadId: "thread-forward-refresh",
      status: "failed" as const,
      startedAt: 2,
      finishedAt: 3,
      error: "provider failed",
    };
    const getLatestRun = vi.fn(async () => latestRun);
    const snapshot = await loadStoredThreadSnapshot({
      store: {
        getThread: vi.fn(async () => ({
          id: "thread-forward-refresh",
          sessionId: "session-forward-refresh",
          createdAt: 1,
          updatedAt: 3,
        })),
        listTranscriptPage: vi.fn(async () => ({records: []})),
        getLatestRun,
      },
      threadId: "thread-forward-refresh",
    });

    expect(snapshot.runs).toEqual([latestRun]);
    expect(getLatestRun).toHaveBeenCalledOnce();
  });
});
