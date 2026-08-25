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
    expect(scheduler.getSnapshot()).toEqual({
      active: 2,
      queued: 3,
      retrying: 0,
      oldestAdmissionRetryAgeMs: 0,
      maxConcurrentRuns: 2,
    });

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
      async onAttemptSettled(threadId) {
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
      onAttemptSettled(threadId) {
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

  it("atomically reserves reset work and aborts the active run", async () => {
    const activeStarted = createDeferred<void>();
    const order: string[] = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(_threadId, signal) {
        order.push("run");
        activeStarted.resolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), {once: true});
        });
        order.push("aborted");
        return {outcome: "aborted"};
      },
    });

    scheduler.start();
    scheduler.schedule("thread");
    await activeStarted.promise;
    const reason = new Error("reset requested");
    const exclusive = scheduler.runExclusively("thread", async () => {
      order.push("exclusive");
    }, {
      abortActiveReason: reason,
      beforeActiveAbort: async () => {
        order.push("persist");
      },
    });

    await exclusive;
    expect(order).toEqual(["run", "persist", "aborted", "exclusive"]);
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

  it("lets exclusive work supersede a delayed admission retry", async () => {
    const retryObserved = createDeferred<void>();
    const order: string[] = [];
    const runIds: string[] = [];
    let attempts = 0;
    let scheduler!: ThreadRunScheduler;
    scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(_threadId, _signal, runId) {
        attempts += 1;
        runIds.push(runId);
        order.push(`run:${attempts}`);
        if (attempts === 1) {
          return {outcome: "admission_failed", error: new Error("database unavailable")};
        }
        return DURABLY_COMPLETED;
      },
      onAdmissionRetry() {
        retryObserved.resolve();
      },
      onExclusiveSettled(threadId) {
        scheduler.schedule(threadId);
      },
    });

    scheduler.start();
    scheduler.schedule("thread");
    await retryObserved.promise;
    await scheduler.runExclusively("thread", async () => {
      order.push("exclusive");
    });
    await scheduler.waitForIdle("thread");

    expect(order).toEqual(["run:1", "exclusive", "run:2"]);
    expect(new Set(runIds).size).toBe(1);
    expect(scheduler.getSnapshot()).toMatchObject({active: 0, queued: 0, retrying: 0});
  });

  it("preserves admission work when reserved exclusive work also fails", async () => {
    const firstAttemptStarted = createDeferred<void>();
    const releaseFirstAttempt = createDeferred<void>();
    let attempts = 0;
    const runIds: string[] = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(_threadId, _signal, runId) {
        attempts += 1;
        runIds.push(runId);
        if (attempts === 1) {
          firstAttemptStarted.resolve();
          await releaseFirstAttempt.promise;
          return {outcome: "admission_failed", error: new Error("database unavailable")};
        }
        return DURABLY_COMPLETED;
      },
    });

    scheduler.start();
    scheduler.schedule("thread");
    await firstAttemptStarted.promise;
    const exclusive = scheduler.runExclusively("thread", async () => {
      throw new Error("reset failed");
    });
    releaseFirstAttempt.resolve();

    await expect(exclusive).rejects.toThrow("reset failed");
    await scheduler.waitForIdle("thread");
    expect(attempts).toBe(2);
    expect(new Set(runIds).size).toBe(1);
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

  it("retries admission without consuming capacity or requiring another wake", async () => {
    const admissionError = new Error("database connection reset before claim");
    const retryObserved = createDeferred<void>();
    const healthyStarted = createDeferred<void>();
    const releaseHealthy = createDeferred<void>();
    const order: string[] = [];
    let retryingAttempts = 0;
    const retryingRunIds: string[] = [];
    const retries: Array<{attempt: number; delayMs: number}> = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(threadId, _signal, runId) {
        order.push(threadId);
        if (threadId === "retrying") {
          retryingAttempts += 1;
          retryingRunIds.push(runId);
          if (retryingAttempts === 1) {
            return {outcome: "admission_failed", error: admissionError};
          }
          return DURABLY_COMPLETED;
        }
        healthyStarted.resolve();
        await releaseHealthy.promise;
        return DURABLY_COMPLETED;
      },
      onAdmissionRetry({attempt, delayMs}) {
        retries.push({attempt, delayMs});
        retryObserved.resolve();
      },
    });

    scheduler.start();
    scheduler.schedule("retrying");
    scheduler.schedule("healthy");
    const retryingIdle = scheduler.waitForIdle("retrying");
    await retryObserved.promise;
    await healthyStarted.promise;

    expect(order).toEqual(["retrying", "healthy"]);
    expect(scheduler.getSnapshot()).toMatchObject({active: 1, queued: 1, retrying: 1});
    expect(retries).toEqual([{attempt: 1, delayMs: expect.any(Number)}]);
    expect(retries[0]!.delayMs).toBeGreaterThanOrEqual(50);
    expect(retries[0]!.delayMs).toBeLessThanOrEqual(100);

    // More NOTIFY hints still represent the same durable lane and cannot skip
    // the admission backoff or create parallel attempts.
    scheduler.schedule("retrying");
    scheduler.schedule("retrying");
    releaseHealthy.resolve();
    await Promise.all([scheduler.waitForIdle("healthy"), retryingIdle]);

    expect(order).toEqual(["retrying", "healthy", "retrying"]);
    expect(retryingAttempts).toBe(2);
    expect(new Set(retryingRunIds).size).toBe(1);
  });

  it("keeps repeated admission retries bounded and cancels them on shutdown", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const admissionError = new Error("database unavailable");
    let attempts = 0;
    const delays: number[] = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run() {
        attempts += 1;
        return {outcome: "admission_failed", error: admissionError};
      },
      onAdmissionRetry({delayMs}) {
        delays.push(delayMs);
      },
    });

    try {
      scheduler.start();
      scheduler.schedule("thread");
      const idle = scheduler.waitForIdle("thread");
      await vi.advanceTimersByTimeAsync(0);

      const expectedDelays = [100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000];
      for (const [index, delayMs] of expectedDelays.entries()) {
        expect(delays[index]).toBe(delayMs);
        scheduler.schedule("thread");
        scheduler.schedule("thread");
        await vi.advanceTimersByTimeAsync(delayMs);
      }
      expect(attempts).toBe(expectedDelays.length + 1);
      expect(scheduler.getSnapshot()).toMatchObject({active: 0, queued: 1, retrying: 1});

      const shutdown = new Error("shutdown");
      await scheduler.stop(shutdown);
      await expect(idle).rejects.toBe(shutdown);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(attempts).toBe(expectedDelays.length + 1);
      expect(scheduler.getSnapshot()).toMatchObject({active: 0, queued: 0, retrying: 0});
    } finally {
      await scheduler.stop();
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("drains a delayed ambiguous admission id during shutdown", async () => {
    const retryObserved = createDeferred<void>();
    const shutdownReason = new Error("shutdown");
    const attemptedRunIds: string[] = [];
    const reconciled: Array<{threadId: string; runId: string; reason: unknown}> = [];
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run(_threadId, _signal, runId) {
        attemptedRunIds.push(runId);
        return {outcome: "admission_failed", error: new Error("ambiguous claim")};
      },
      onAdmissionRetry() {
        retryObserved.resolve();
      },
      async onAdmissionShutdown(threadId, runId, reason) {
        reconciled.push({threadId, runId, reason});
      },
    });

    scheduler.start();
    scheduler.schedule("thread");
    await retryObserved.promise;
    const idle = scheduler.waitForIdle("thread");
    await scheduler.stop(shutdownReason);

    await expect(idle).rejects.toBe(shutdownReason);
    expect(attemptedRunIds).toHaveLength(1);
    expect(reconciled).toEqual([{
      threadId: "thread",
      runId: attemptedRunIds[0],
      reason: shutdownReason,
    }]);
  });

  it("shares one admission drain across concurrent shutdown callers", async () => {
    const retryObserved = createDeferred<void>();
    const drainStarted = createDeferred<void>();
    const releaseDrain = createDeferred<void>();
    const shutdownReason = new Error("shutdown");
    let drainCalls = 0;
    const scheduler = new ThreadRunScheduler({
      maxConcurrentRuns: 1,
      async run() {
        return {outcome: "admission_failed", error: new Error("ambiguous claim")};
      },
      onAdmissionRetry() {
        retryObserved.resolve();
      },
      async onAdmissionShutdown() {
        drainCalls += 1;
        drainStarted.resolve();
        await releaseDrain.promise;
      },
    });

    scheduler.start();
    scheduler.schedule("thread");
    await retryObserved.promise;
    const idle = expect(scheduler.waitForIdle("thread")).rejects.toBe(shutdownReason);
    let firstStopped = false;
    let secondStopped = false;
    const firstStop = scheduler.stop(shutdownReason).then(() => {
      firstStopped = true;
    });
    await drainStarted.promise;
    const secondStop = scheduler.stop(new Error("later shutdown")).then(() => {
      secondStopped = true;
    });
    await nextTurn();

    expect(firstStopped).toBe(false);
    expect(secondStopped).toBe(false);
    expect(drainCalls).toBe(1);

    releaseDrain.resolve();
    await Promise.all([firstStop, secondStop, idle]);
    expect(firstStopped).toBe(true);
    expect(secondStopped).toBe(true);
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
      onAttemptSettled: runSettled,
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
    expect(scheduler.getSnapshot()).toEqual({
      active: 0,
      queued: 0,
      retrying: 0,
      oldestAdmissionRetryAgeMs: 0,
      maxConcurrentRuns: 1,
    });
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
