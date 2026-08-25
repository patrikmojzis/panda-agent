import {describe, expect, it} from "vitest";

import {
  StaleThreadCompactionError,
  ThreadRunClaimLostError,
} from "../src/domain/threads/runtime/store.js";
import {parseMessageRow} from "../src/domain/threads/runtime/postgres-rows.js";
import {createCompactBoundaryMessage} from "../src/kernel/transcript/compaction.js";
import {stringToUserMessage} from "../src/kernel/agent/helpers/input.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

async function createStore(threadId: string): Promise<TestThreadRuntimeStore> {
  const store = new TestThreadRuntimeStore();
  await store.createThread({id: threadId, sessionId: `session-${threadId}`});
  return store;
}

function compactMetadata(compactedThroughSequence: number) {
  return {
    kind: "compact_boundary" as const,
    compactedThroughSequence,
    preservedTailUserTurns: 3,
    trigger: "manual" as const,
    tokensBefore: 1_000,
    tokensAfter: 300,
  };
}

const manualOwner = {
  source: "daemon",
  connectorKey: "core",
  holderId: "checkpoint-test",
};

function commitManualCompaction(
  store: TestThreadRuntimeStore,
  threadId: string,
  commit: Parameters<TestThreadRuntimeStore["commitCompactionExclusively"]>[1],
) {
  return store.commitCompactionExclusively(threadId, commit, manualOwner);
}

describe("thread transcript checkpoints", () => {
  it("loads only the latest checkpoint and its ordinary active tail", async () => {
    const store = await createStore("thread-repeated");
    for (let index = 1; index <= 4; index += 1) {
      await store.appendRuntimeMessage("thread-repeated", {
        source: "tui",
        message: stringToUserMessage(`message ${index}`),
      });
    }

    const first = await commitManualCompaction(store, "thread-repeated", {
      expectedCheckpointId: null,
      message: createCompactBoundaryMessage("first summary"),
      metadata: compactMetadata(2),
    });
    await store.appendRuntimeMessage("thread-repeated", {
      source: "tui",
      message: stringToUserMessage("preserved tail"),
    });
    const second = await commitManualCompaction(store, "thread-repeated", {
      expectedCheckpointId: first.id,
      message: createCompactBoundaryMessage("second summary"),
      metadata: compactMetadata(4),
    });
    await store.appendRuntimeMessage("thread-repeated", {
      source: "tui",
      message: stringToUserMessage("after second checkpoint"),
    });

    const active = await store.loadActiveTranscript("thread-repeated");

    expect(active.checkpointId).toBe(second.id);
    expect(active.records.map((record) => record.sequence)).toEqual([7, 6, 8]);
    expect(active.records).not.toContainEqual(expect.objectContaining({id: first.id}));
  });

  it("rejects a stale checkpoint commit", async () => {
    const store = await createStore("thread-stale");
    await store.appendRuntimeMessage("thread-stale", {
      source: "tui",
      message: stringToUserMessage("one"),
    });
    const checkpoint = await commitManualCompaction(store, "thread-stale", {
      expectedCheckpointId: null,
      message: createCompactBoundaryMessage("summary"),
      metadata: compactMetadata(1),
    });

    await expect(commitManualCompaction(store, "thread-stale", {
      expectedCheckpointId: null,
      message: createCompactBoundaryMessage("stale summary"),
      metadata: compactMetadata(1),
    })).rejects.toBeInstanceOf(StaleThreadCompactionError);
    await expect(store.loadActiveTranscript("thread-stale")).resolves.toMatchObject({
      checkpointId: checkpoint.id,
    });
  });

  it("paginates durable history without overlap", async () => {
    const store = await createStore("thread-pages");
    for (let index = 1; index <= 5; index += 1) {
      await store.appendRuntimeMessage("thread-pages", {
        source: "tui",
        message: stringToUserMessage(`message ${index}`),
      });
    }

    const newest = await store.listTranscriptPage("thread-pages", {limit: 2});
    const middle = await store.listTranscriptPage("thread-pages", {
      beforeSequence: newest.nextBeforeSequence,
      limit: 2,
    });
    const oldest = await store.listTranscriptPage("thread-pages", {
      beforeSequence: middle.nextBeforeSequence,
      limit: 2,
    });

    expect(newest.records.map((record) => record.sequence)).toEqual([4, 5]);
    expect(middle.records.map((record) => record.sequence)).toEqual([2, 3]);
    expect(oldest.records.map((record) => record.sequence)).toEqual([1]);
    expect(oldest.nextBeforeSequence).toBeUndefined();
  });

  it("seeks forward without rereading observed history", async () => {
    const store = await createStore("thread-forward-pages");
    for (let index = 1; index <= 5; index += 1) {
      await store.appendRuntimeMessage("thread-forward-pages", {
        source: "tui",
        message: stringToUserMessage(`message ${index}`),
      });
    }

    const first = await store.listTranscriptPage("thread-forward-pages", {
      afterSequence: 2,
      limit: 2,
    });
    const second = await store.listTranscriptPage("thread-forward-pages", {
      afterSequence: first.nextAfterSequence!,
      limit: 2,
    });

    expect(first.records.map((record) => record.sequence)).toEqual([3, 4]);
    expect(first.nextAfterSequence).toBe(4);
    expect(second.records.map((record) => record.sequence)).toEqual([5]);
    expect(second.nextAfterSequence).toBeUndefined();
  });

  it("rejects checkpoints owned by a run that already settled", async () => {
    const store = await createStore("thread-run-fence");
    const message = await store.appendRuntimeMessage("thread-run-fence", {
      source: "tui",
      message: stringToUserMessage("one"),
    });
    const run = await store.createRun("thread-run-fence");
    await store.completeRun(run.id);

    await expect(store.commitCompaction("thread-run-fence", {
      expectedCheckpointId: null,
      message: createCompactBoundaryMessage("stale summary"),
      metadata: compactMetadata(message.sequence),
      runId: run.id,
    })).rejects.toBeInstanceOf(ThreadRunClaimLostError);
  });

  it("reconstructs checkpoint metadata only from the typed database column", () => {
    const row = {
      id: "checkpoint-row",
      thread_id: "thread-row",
      sequence: "8",
      origin: "runtime",
      source: "compact",
      channel_id: null,
      external_message_id: null,
      actor_id: null,
      identity_id: null,
      input_id: null,
      run_id: null,
      created_at: new Date(1),
      message: createCompactBoundaryMessage("summary"),
      metadata: {
        kind: "compact_boundary",
        preservedTailUserTurns: 3,
        trigger: "manual",
        tokensBefore: 1_000,
        tokensAfter: 300,
      },
      compacted_through_sequence: "5",
    };

    expect(parseMessageRow(row).metadata).toMatchObject({
      kind: "compact_boundary",
      compactedThroughSequence: 5,
    });
    expect(() => parseMessageRow({
      ...row,
      compacted_through_sequence: null,
    })).toThrow("missing its typed checkpoint sequence");
    expect(() => parseMessageRow({
      ...row,
      metadata: {...row.metadata, compactedThroughSequence: 5},
    })).toThrow("must not be duplicated in metadata");
  });

  it("reserves compact boundaries for the atomic commit seam", async () => {
    const store = await createStore("thread-boundary-write");

    await expect(store.appendRuntimeMessage("thread-boundary-write", {
      source: "compact",
      message: createCompactBoundaryMessage("summary"),
      metadata: compactMetadata(0),
    })).rejects.toThrow("commitCompaction");
  });
});
