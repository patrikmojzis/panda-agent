import {describe, expect, it, vi} from "vitest";

import {ThreadRunScheduler} from "../src/domain/threads/runtime/scheduler.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

async function nextTurn(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

const DURABLY_COMPLETED = {outcome: "completed"} as const;

describe("ThreadRunScheduler", () => {
  it("bounds global concurrency while preserving FIFO order", async () => {
    const gates = new Map<string, ReturnType<typeof createDeferred<void>>>();
    const started: string[] = [];
    let active = 0;
    let peak = 0;
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 2,
      async run(threadId) {
        active += 1;
        peak = Math.max(peak, active);
        started.push(threadId);
        const gate = createDeferred<void>();
        gates.set(threadId, gate);
        await gate.promise;
        active -= 1;
        return DURABLY_COMPLETED;
      },
    });

    scheduler.start();
    for (const threadId of ["one", "two", "three", "four", "five"]) {
      scheduler.schedule(threadId);
    }
    await nextTurn();

    expect(started).toEqual(["one", "two"]);
    expect(scheduler.getSnapshot()).toEqual({active: 2, queued: 3, maxConcurrentRuns: 2});

    gates.get("one")?.resolve();
    await nextTurn();
    expect(started).toEqual(["one", "two", "three"]);

    gates.get("two")?.resolve();
    gates.get("three")?.resolve();
    await nextTurn();
    expect(started).toEqual(["one", "two", "three", "four", "five"]);
    expect(peak).toBe(2);

    gates.get("four")?.resolve();
    gates.get("five")?.resolve();
    await Promise.all([scheduler.waitForIdle("four"), scheduler.waitForIdle("five")]);
  });

  it("does not leave capacity idle while settlement reconciliation waits", async () => {
    const firstRun = createDeferred<void>();
    const firstSettlement = createDeferred<void>();
    const followupRun = createDeferred<void>();
    const started: string[] = [];
    let firstAttempts = 0;
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(threadId) {
        started.push(threadId);
        if (threadId === "first") {
          firstAttempts += 1;
          await (firstAttempts === 1 ? firstRun.promise : followupRun.promise);
        }
        return DURABLY_COMPLETED;
      },
      async onRunSettled(threadId) {
        if (threadId === "first" && firstAttempts === 1) {
          await firstSettlement.promise;
          scheduler.schedule("first");
        }
      },
    });

    scheduler.start();
    scheduler.schedule("first");
    scheduler.schedule("second");
    await nextTurn();
    firstRun.resolve();
    await nextTurn();

    expect(started).toEqual(["first", "second"]);
    let firstIdleResolved = false;
    const firstIdle = scheduler.waitForIdle("first").then(() => {
      firstIdleResolved = true;
    });
    await nextTurn();
    expect(firstIdleResolved).toBe(false);
    await scheduler.waitForIdle("second");

    firstSettlement.resolve();
    await nextTurn();
    expect(started).toEqual(["first", "second", "first"]);
    expect(firstIdleResolved).toBe(false);

    followupRun.resolve();
    await firstIdle;
    expect(firstIdleResolved).toBe(true);
  });

  it("deduplicates queued wakes and lets durable settlement reconciliation schedule a follow-up", async () => {
    const gates: Array<ReturnType<typeof createDeferred<void>>> = [];
    let durableRunnable = false;
    const run = vi.fn(async () => {
      const gate = createDeferred<void>();
      gates.push(gate);
      await gate.promise;
      return DURABLY_COMPLETED;
    });
    let scheduler!: ThreadRunScheduler;
    scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      run,
      onRunSettled(threadId) {
        if (durableRunnable) {
          durableRunnable = false;
          scheduler.schedule(threadId);
        }
      },
    });

    scheduler.schedule("thread");
    scheduler.schedule("thread");
    scheduler.start();
    await nextTurn();
    expect(run).toHaveBeenCalledTimes(1);

    scheduler.schedule("thread");
    scheduler.schedule("thread");
    durableRunnable = true;
    gates[0]?.resolve();
    await nextTurn();
    expect(run).toHaveBeenCalledTimes(2);

    gates[1]?.resolve();
    await scheduler.waitForIdle("thread");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("reserves exclusive work directly behind an active run", async () => {
    const activeGate = createDeferred<void>();
    const exclusiveGate = createDeferred<void>();
    const order: string[] = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(threadId) {
        order.push(`run:${threadId}`);
        await activeGate.promise;
        return DURABLY_COMPLETED;
      },
    });

    scheduler.start();
    scheduler.schedule("thread");
    await nextTurn();
    const exclusive = scheduler.runExclusively("thread", async () => {
      order.push("exclusive:thread");
      await exclusiveGate.promise;
      return "done";
    });

    activeGate.resolve();
    await nextTurn();
    expect(order).toEqual(["run:thread", "exclusive:thread"]);

    scheduler.schedule("thread");
    exclusiveGate.resolve();
    await expect(exclusive).resolves.toBe("done");
    await nextTurn();
    expect(order).toEqual(["run:thread", "exclusive:thread"]);
  });

  it("lets a queued exclusive operation supersede a queued run", async () => {
    const blocker = createDeferred<void>();
    const order: string[] = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(threadId) {
        order.push(`run:${threadId}`);
        if (threadId === "blocker") {
          await blocker.promise;
        }
        return DURABLY_COMPLETED;
      },
    });

    scheduler.start();
    scheduler.schedule("blocker");
    scheduler.schedule("thread");
    await nextTurn();
    const exclusive = scheduler.runExclusively("thread", async () => {
      order.push("exclusive:thread");
    });

    blocker.resolve();
    await exclusive;
    expect(order).toEqual(["run:blocker", "exclusive:thread"]);
  });

  it("replays a wake that arrived during failed exclusive work", async () => {
    const exclusiveStarted = createDeferred<void>();
    const releaseExclusive = createDeferred<void>();
    const failure = new Error("exclusive failed");
    const run = vi.fn(async () => DURABLY_COMPLETED);
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      run,
    });
    scheduler.start();

    const exclusive = scheduler.runExclusively("thread", async () => {
      exclusiveStarted.resolve();
      await releaseExclusive.promise;
      throw failure;
    });
    await exclusiveStarted.promise;
    scheduler.schedule("thread");
    releaseExclusive.resolve();

    await expect(exclusive).rejects.toBe(failure);
    await scheduler.waitForIdle("thread");
    expect(run).toHaveBeenCalledOnce();
  });

  it("rejects overlapping exclusive operations for the same thread", async () => {
    const gate = createDeferred<void>();
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run() {
        return DURABLY_COMPLETED;
      },
    });
    scheduler.start();

    const first = scheduler.runExclusively("thread", () => gate.promise);
    await nextTurn();
    await expect(scheduler.runExclusively("thread", async () => undefined)).rejects.toThrow(
      "Thread already has an exclusive operation in progress.",
    );
    gate.resolve();
    await first;
  });

  it("reports a failed run without losing scheduler capacity", async () => {
    const failure = new Error("provider failed");
    const errors: Array<{threadId: string; error: unknown}> = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(threadId) {
        if (threadId === "broken") {
          throw failure;
        }
        return DURABLY_COMPLETED;
      },
      onError(threadId, error) {
        errors.push({threadId, error});
      },
    });

    scheduler.start();
    scheduler.schedule("broken");
    scheduler.schedule("healthy");

    await expect(scheduler.waitForIdle("broken")).rejects.toBe(failure);
    await scheduler.waitForIdle("healthy");
    expect(errors).toEqual([{threadId: "broken", error: failure}]);
    expect(scheduler.getSnapshot().active).toBe(0);
  });

  it("retains one wake that arrives during a failed run", async () => {
    const firstGate = createDeferred<void>();
    const secondGate = createDeferred<void>();
    let attempts = 0;
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run() {
        attempts += 1;
        if (attempts === 1) {
          await firstGate.promise;
          throw new Error("provider failed");
        }
        await secondGate.promise;
        return DURABLY_COMPLETED;
      },
    });

    scheduler.start();
    scheduler.schedule("thread");
    await nextTurn();
    scheduler.schedule("thread");
    scheduler.schedule("thread");
    const idle = scheduler.waitForIdle("thread");
    firstGate.resolve();
    await nextTurn();

    expect(attempts).toBe(2);
    secondGate.resolve();
    await expect(idle).resolves.toBeUndefined();
  });

  it("admits backlog within a bounded interactive burst", async () => {
    const blocker = createDeferred<void>();
    const order: string[] = [];
    let nextInteractive = 1;
    let scheduler!: ThreadRunScheduler;
    scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      maxInteractiveBurst: 4,
      async run(threadId) {
        order.push(threadId);
        if (threadId === "blocker") {
          await blocker.promise;
        } else if (threadId.startsWith("interactive-") && nextInteractive < 10) {
          scheduler.schedule(`interactive-${nextInteractive}`);
          nextInteractive += 1;
        }
        return DURABLY_COMPLETED;
      },
    });
    scheduler.start();
    scheduler.schedule("blocker");
    await nextTurn();
    scheduler.schedule("backlog", "backlog");
    scheduler.schedule("interactive-0");

    blocker.resolve();
    await scheduler.waitForIdle("backlog");

    expect(order.indexOf("backlog")).toBeGreaterThan(0);
    expect(order.indexOf("backlog")).toBeLessThanOrEqual(5);
  });

  it("replays a wake after exclusive work fails", async () => {
    const exclusiveGate = createDeferred<void>();
    const run = vi.fn(async () => DURABLY_COMPLETED);
    const scheduler = new ThreadRunScheduler({maxConcurrentRuns: 1, run});
    scheduler.start();

    const exclusive = scheduler.runExclusively("thread", async () => {
      await exclusiveGate.promise;
      throw new Error("reset failed");
    });
    await nextTurn();
    scheduler.schedule("thread");
    exclusiveGate.resolve();
    await expect(exclusive).rejects.toThrow("reset failed");
    await nextTurn();

    expect(run).toHaveBeenCalledOnce();
    await scheduler.waitForIdle("thread");
  });

  it("prioritizes queued control work and interactive wakes over backlog", async () => {
    const blocker = createDeferred<void>();
    const order: string[] = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(threadId) {
        order.push(`run:${threadId}`);
        if (threadId === "blocker") {
          await blocker.promise;
        }
        return DURABLY_COMPLETED;
      },
    });
    scheduler.start();
    scheduler.schedule("blocker");
    await nextTurn();
    scheduler.schedule("backlog-a", "backlog");
    scheduler.schedule("control", "backlog");
    scheduler.schedule("backlog-b", "backlog");
    scheduler.schedule("interactive");
    const exclusive = scheduler.runExclusively("control", async () => {
      order.push("exclusive:control");
    });
    await nextTurn();
    blocker.resolve();
    await exclusive;
    await scheduler.waitForIdle("backlog-b");

    expect(order.slice(0, 3)).toEqual([
      "run:blocker",
      "exclusive:control",
      "run:interactive",
    ]);
  });

  it("reports run outcome separately from capacity released by exclusive work", async () => {
    const runSettled = vi.fn();
    const capacityAvailable = vi.fn();
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run() {
        return {outcome: "no_claim" as const};
      },
      onRunSettled: runSettled,
      onCapacityAvailable: capacityAvailable,
    });

    scheduler.start();
    scheduler.schedule("thread");
    await scheduler.waitForIdle("thread");
    expect(runSettled).toHaveBeenCalledOnce();
    expect(runSettled).toHaveBeenCalledWith("thread", {outcome: "no_claim"});
    expect(capacityAvailable).toHaveBeenCalledOnce();

    await scheduler.runExclusively("thread", async () => undefined);
    expect(runSettled).toHaveBeenCalledOnce();
    expect(capacityAvailable).toHaveBeenCalledTimes(2);
  });

  it("rejects queued work and aborts active work during shutdown", async () => {
    const signals = new Map<string, AbortSignal>();
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(threadId, signal) {
        signals.set(threadId, signal);
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), {once: true}));
        return DURABLY_COMPLETED;
      },
    });

    scheduler.start();
    scheduler.schedule("active");
    scheduler.schedule("queued");
    await nextTurn();

    await scheduler.stop(new Error("shutdown"));
    expect(signals.get("active")?.aborted).toBe(true);
    expect(signals.has("queued")).toBe(false);
    expect(scheduler.getSnapshot()).toEqual({active: 0, queued: 0, maxConcurrentRuns: 1});
  });

  it("bounds shutdown when active work ignores cancellation", async () => {
    const gate = createDeferred<void>();
    const errors: unknown[] = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      shutdownDrainTimeoutMs: 10,
      async run() {
        await gate.promise;
        return DURABLY_COMPLETED;
      },
      onError(_threadId, error) {
        errors.push(error);
      },
    });
    scheduler.start();
    scheduler.schedule("stuck");
    await nextTurn();

    await scheduler.stop(new Error("shutdown"));
    expect(errors).toEqual([
      expect.objectContaining({message: expect.stringContaining("shutdown exceeded 10ms")}),
    ]);

    gate.resolve();
    await nextTurn();
  });
});
