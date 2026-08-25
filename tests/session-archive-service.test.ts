import {describe, expect, it} from "vitest";

import {SessionArchiveService} from "../src/app/runtime/session-archive-service.js";
import type {SessionArchiveResult} from "../src/domain/sessions/archive.js";
import type {SessionRecord} from "../src/domain/sessions/types.js";

function session(input: Pick<SessionRecord, "id" | "kind" | "currentThreadId">): SessionRecord {
  return {
    ...input,
    agentKey: "panda",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("SessionArchiveService", () => {
  it("stops every direct subagent across storage batches", async () => {
    const parent = session({id: "parent", kind: "branch", currentThreadId: "parent-thread"});
    const children = Array.from({length: 101}, (_, index) => ({
      sessionId: `child-${String(index).padStart(3, "0")}`,
      currentThreadId: `child-thread-${index}`,
    }));
    const stoppedThreads = new Set<string>();
    const cancelledThreads = new Set<string>();
    const archived: SessionArchiveResult = {
      session: {...parent, archivedAt: 2},
      discardedInputs: 0,
      cancelledTaskRuns: 0,
      failedWatchRuns: 0,
      failedDeliveries: 0,
      failedActions: 0,
      failedVoiceTurns: 0,
    };
    const signal = new AbortController().signal;
    const owner = {source: "daemon", connectorKey: "primary", holderId: "holder"} as const;
    const service = new SessionArchiveService({
      sessions: {
        getSession: async () => parent,
        listDirectSubagentThreads: async ({afterSessionId, limit}) => {
          const start = afterSessionId
            ? children.findIndex((child) => child.sessionId === afterSessionId) + 1
            : 0;
          return children.slice(start, start + limit);
        },
      },
      archiveStore: {
        archive: async () => archived,
        restore: async () => parent,
      },
      coordinator: {
        abort: async (threadId) => {
          stoppedThreads.add(threadId);
          return true;
        },
        runExclusively: async (_threadId, run) => run({signal, owner}),
      },
      backgroundJobs: {
        cancelThreadJobs: async (threadId) => {
          cancelledThreads.add(threadId);
          return 0;
        },
      },
    });

    await expect(service.archive("parent", "operation-id")).resolves.toMatchObject({
      stoppedSubagents: 101,
    });
    expect(stoppedThreads).toEqual(new Set(["parent-thread", ...children.map((child) => child.currentThreadId)]));
    expect(cancelledThreads).toEqual(new Set(["parent-thread", ...children.map((child) => child.currentThreadId)]));
  });
});
