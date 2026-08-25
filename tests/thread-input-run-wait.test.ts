import {randomUUID} from "node:crypto";

import {afterEach, describe, expect, it, vi} from "vitest";

import {ThreadRuntimeCoordinator} from "../src/domain/threads/runtime/coordinator.js";
import type {ThreadRunOwner} from "../src/domain/threads/runtime/types.js";
import {stringToUserMessage} from "../src/kernel/agent/helpers/input.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

const TEST_OWNER: ThreadRunOwner = {
  source: "panda-core",
  connectorKey: "test",
  holderId: "thread-input-run-wait-test",
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function createHarness() {
  const store = new TestThreadRuntimeStore();
  const thread = await store.createThread({
    id: "causal-wait-thread",
    sessionId: "causal-wait-session",
  });
  const coordinator = new ThreadRuntimeCoordinator({
    store,
    maxConcurrentRuns: 1,
    resolveDefinition: async () => {
      throw new Error("The causal-wait tests do not execute the model runtime.");
    },
  });
  await coordinator.handleStoreNotificationStatus("listening");
  await coordinator.start(TEST_OWNER);
  return {coordinator, store, thread};
}

async function enqueueAndApply(
  store: TestThreadRuntimeStore,
  threadId: string,
) {
  const enqueue = await store.enqueueInput(threadId, {
    message: stringToUserMessage("run this exact input"),
    source: "test",
  });
  const run = await store.tryStartRun(threadId, TEST_OWNER, randomUUID());
  if (!run) {
    throw new Error("Expected the input's run claim to succeed.");
  }
  await store.applyPendingInputs(threadId, run.id);
  return {input: enqueue.input, run};
}

async function waitForAuthoritativeReads(getInput: ReturnType<typeof vi.fn>): Promise<void> {
  for (let attempt = 0; attempt < 20 && getInput.mock.calls.length < 2; attempt += 1) {
    await Promise.resolve();
  }
  expect(getInput).toHaveBeenCalledTimes(2);
}

describe("ThreadRuntimeCoordinator.waitForInputRun", () => {
  it("ignores unrelated runs on the same thread", async () => {
    const {coordinator, store, thread} = await createHarness();
    try {
      const unrelated = await store.createRun(thread.id);
      await store.failRunIfRunning(unrelated.id, "historical unrelated run");
      const {input, run} = await enqueueAndApply(store, thread.id);
      const getInput = vi.spyOn(store, "getInput");

      let settled = false;
      const waiting = coordinator.waitForInputRun(input.id).finally(() => {
        settled = true;
      });
      await waitForAuthoritativeReads(getInput);
      expect(settled).toBe(false);

      await store.completeRun(run.id);
      await coordinator.handleStoreNotification({kind: "thread_changed", threadId: thread.id});
      await expect(waiting).resolves.toMatchObject({id: run.id, status: "completed"});
    } finally {
      await coordinator.stop();
    }
  });

  it("returns only the terminal run named by the input's applied run id", async () => {
    const {coordinator, store, thread} = await createHarness();
    try {
      const {input, run} = await enqueueAndApply(store, thread.id);
      await store.completeRun(run.id);

      const result = await coordinator.waitForInputRun(input.id);
      expect(result.id).toBe(run.id);
      expect((await store.getInput(input.id)).appliedRunId).toBe(run.id);
      expect(result.status).toBe("completed");
    } finally {
      await coordinator.stop();
    }
  });

  it("rejects an input discarded by reset before execution", async () => {
    const {coordinator, store, thread} = await createHarness();
    try {
      const enqueue = await store.enqueueInput(thread.id, {
        message: stringToUserMessage("discard me"),
        source: "test",
      });
      await store.discardPendingInputs(thread.id);

      await expect(coordinator.waitForInputRun(enqueue.input.id))
        .rejects.toThrow(`Thread input ${enqueue.input.id} was discarded before execution.`);
    } finally {
      await coordinator.stop();
    }
  });

  it("wakes a causal wait from a thread change notification", async () => {
    const {coordinator, store, thread} = await createHarness();
    try {
      const {input, run} = await enqueueAndApply(store, thread.id);
      const getInput = vi.spyOn(store, "getInput");
      const waiting = coordinator.waitForInputRun(input.id);
      await waitForAuthoritativeReads(getInput);

      await store.completeRun(run.id);
      await coordinator.handleStoreNotification({kind: "thread_changed", threadId: thread.id});

      await expect(waiting).resolves.toMatchObject({id: run.id, status: "completed"});
    } finally {
      await coordinator.stop();
    }
  });

  it("falls back to a bounded durable reread while LISTEN is unhealthy", async () => {
    vi.useFakeTimers();
    const {coordinator, store, thread} = await createHarness();
    try {
      await coordinator.handleStoreNotificationStatus("reconnecting");
      const {input, run} = await enqueueAndApply(store, thread.id);
      const getInput = vi.spyOn(store, "getInput");
      const waiting = coordinator.waitForInputRun(input.id);
      await waitForAuthoritativeReads(getInput);

      await store.completeRun(run.id);
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(waiting).resolves.toMatchObject({id: run.id, status: "completed"});
    } finally {
      await coordinator.stop();
    }
  });
});
