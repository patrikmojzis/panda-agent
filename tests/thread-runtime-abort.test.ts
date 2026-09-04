import {describe, expect, it, vi} from "vitest";

import {Agent, type LlmRuntime, stringToUserMessage} from "../src/index.js";
import {ThreadRuntimeCoordinator} from "../src/app/sdk/thread-runtime.js";
import type {ThreadRunOwner} from "../src/domain/threads/runtime/types.js";
import type {LlmRuntimeRequest} from "../src/kernel/agent/runtime.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";
import {waitFor} from "./helpers/wait-for.js";

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

class AbortableRuntime implements LlmRuntime {
  readonly started = createDeferred<AbortSignal>();
  readonly complete = vi.fn(async (request: LlmRuntimeRequest) => {
    const signal = request.signal;
    if (!signal) {
      throw new Error("Expected the thread run to provide an abort signal.");
    }

    this.started.resolve(signal);
    return new Promise<never>((_resolve, reject) => {
      const rejectFromAbort = () => reject(
        signal.reason instanceof Error ? signal.reason : new Error("Run aborted."),
      );
      if (signal.aborted) {
        rejectFromAbort();
        return;
      }
      signal.addEventListener("abort", rejectFromAbort, {once: true});
    });
  });
  readonly stream = vi.fn(() => {
    throw new Error("Streaming was not expected in this test.");
  });
}

const TEST_RUN_OWNER: ThreadRunOwner = {
  source: "panda-core",
  connectorKey: "test",
  holderId: "thread-runtime-abort-test",
};

class AbortReadCountingStore extends TestThreadRuntimeStore {
  abortReconciliationReads = 0;
  abortReconciliationFailures = 0;
  nextAbortReconciliationGate: Promise<void> | undefined;

  override async listAbortRequestedRuns(runIds: readonly string[]) {
    this.abortReconciliationReads += 1;
    const requestedRuns = await super.listAbortRequestedRuns(runIds);
    const gate = this.nextAbortReconciliationGate;
    this.nextAbortReconciliationGate = undefined;
    await gate;
    if (this.abortReconciliationFailures > 0) {
      this.abortReconciliationFailures -= 1;
      throw new Error("abort reconciliation read failed");
    }
    return requestedRuns;
  }

}

class RegistrationRaceStore extends AbortReadCountingStore {
  tryStartRunCalls = 0;

  override async tryStartRun(threadId: string, owner: ThreadRunOwner, runId: string) {
    this.tryStartRunCalls += 1;
    const run = await super.tryStartRun(threadId, owner, runId);
    if (!run) {
      return null;
    }
    if (this.tryStartRunCalls === 1) {
      await this.requestRunAbort(threadId, "abort committed before controller registration");
    }
    return run;
  }
}

class GatedRegistrationRaceStore extends RegistrationRaceStore {
  readonly claimEntered = createDeferred<void>();
  readonly releaseClaim = createDeferred<void>();

  override async tryStartRun(threadId: string, owner: ThreadRunOwner, runId: string) {
    const run = await super.tryStartRun(threadId, owner, runId);
    this.claimEntered.resolve();
    await this.releaseClaim.promise;
    return run;
  }
}

class GatedNoClaimStore extends AbortReadCountingStore {
  readonly claimEntered = createDeferred<void>();
  readonly releaseClaim = createDeferred<void>();
  private gateNextClaim = true;

  override async tryStartRun(threadId: string, owner: ThreadRunOwner, runId: string) {
    if (!this.gateNextClaim) {
      return super.tryStartRun(threadId, owner, runId);
    }
    this.gateNextClaim = false;
    // Model a claim statement whose snapshot sees no work. A real wake can
    // commit while that statement is still active, but cannot change its
    // already-established no-claim result.
    const runnableInClaimSnapshot = await this.isThreadRunnable(threadId);
    this.claimEntered.resolve();
    await this.releaseClaim.promise;
    return runnableInClaimSnapshot ? super.tryStartRun(threadId, owner, runId) : null;
  }
}

class AdmissionHeldStore extends AbortReadCountingStore {
  private holdFirstAppliedBatch = true;

  override async applyPendingInputs(threadId: string, runId: string) {
    if (this.holdFirstAppliedBatch) {
      this.holdFirstAppliedBatch = false;
      await this.assertRunActive(runId);
      return [];
    }
    return super.applyPendingInputs(threadId, runId);
  }
}

class TransientShutdownSettlementStore extends AdmissionHeldStore {
  failCalls = 0;
  private failNextSettlementRead = false;

  override async failRun(runId: string, error?: string) {
    this.failCalls += 1;
    if (this.failCalls === 1) {
      this.failNextSettlementRead = true;
      throw new Error("database dropped the first shutdown settlement");
    }
    return super.failRun(runId, error);
  }

  override async getRun(runId: string) {
    if (this.failNextSettlementRead) {
      this.failNextSettlementRead = false;
      throw new Error("database dropped the first settlement reconciliation read");
    }
    return super.getRun(runId);
  }
}

async function createHarness(
  store = new AbortReadCountingStore(),
  notificationStatus: "listening" | "reconnecting" = "listening",
  shutdownDrainTimeoutMs?: number,
) {
  const runtime = new AbortableRuntime();
  const thread = await store.createThread({
    id: "abort-thread",
    sessionId: "abort-session",
  });
  const coordinator = new ThreadRuntimeCoordinator({
    store,
    maxConcurrentRuns: 1,
    shutdownDrainTimeoutMs,
    resolveDefinition: async () => ({
      agent: new Agent({
        name: "abort-agent",
        instructions: "Wait for cancellation.",
      }),
      runtime,
    }),
  });
  await coordinator.handleStoreNotificationStatus(notificationStatus);
  await coordinator.start(TEST_RUN_OWNER);

  const submitted = await coordinator.submitInput(thread.id, {
    message: stringToUserMessage("start"),
    source: "tui",
  });
  const signal = await runtime.started.promise;
  const [run] = await store.listRuns(thread.id);
  if (!run) {
    throw new Error("Expected an active run.");
  }

  return {coordinator, run, runtime, signal, store, submitted, thread};
}

describe("thread runtime abort delivery", () => {
  it("settles and re-arms an admitted run before graceful shutdown returns", async () => {
    const harness = await createHarness(new AdmissionHeldStore());
    expect(await harness.store.getInput(harness.submitted.input.id)).toMatchObject({
      status: "pending",
      deliveryMode: "wake",
    });
    expect(harness.run.admittedThroughInputOrder).toBeGreaterThan(0);

    await harness.coordinator.stop();

    const failedRun = await harness.store.getRun(harness.run.id);
    expect(failedRun.status).toBe("failed");
    expect(failedRun.error).toContain("Thread runtime stopped.");
    expect(await harness.store.getInput(harness.submitted.input.id)).toMatchObject({
      status: "pending",
      deliveryMode: "wake",
    });
    await expect(harness.store.hasPendingWake(harness.thread.id)).resolves.toBe(true);
  });

  it("retries transient terminal writes until the shared shutdown deadline", async () => {
    const store = new TransientShutdownSettlementStore();
    const harness = await createHarness(store, "listening", 1_000);

    await harness.coordinator.stop();

    expect(store.failCalls).toBe(2);
    expect(await store.getRun(harness.run.id)).toMatchObject({status: "failed"});
    expect(await store.getInput(harness.submitted.input.id)).toMatchObject({
      status: "pending",
      deliveryMode: "wake",
    });
  });

  it("does not probe runnable state for UI-only thread changes", async () => {
    const store = new AbortReadCountingStore();
    const thread = await store.createThread({
      id: "notification-routing-thread",
      sessionId: "notification-routing-session",
    });
    const tryStartRun = vi.spyOn(store, "tryStartRun").mockResolvedValue(null);
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      maxConcurrentRuns: 1,
      resolveDefinition: async () => {
        throw new Error("No run should start.");
      },
    });
    await coordinator.handleStoreNotificationStatus("listening");
    await coordinator.start(TEST_RUN_OWNER);
    tryStartRun.mockClear();

    await coordinator.handleStoreNotification({
      kind: "thread_changed",
      threadId: thread.id,
    });
    await Promise.resolve();
    expect(tryStartRun).not.toHaveBeenCalled();

    await coordinator.handleStoreNotification({
      kind: "thread_runnable",
      threadId: thread.id,
    });
    await waitFor(() => {
      expect(tryStartRun).toHaveBeenCalledOnce();
    });
    await coordinator.stop();
  });

  it("reconciles an abort committed before controller registration", async () => {
    const store = new GatedRegistrationRaceStore();
    const runtime = new AbortableRuntime();
    const thread = await store.createThread({
      id: "registration-race-thread",
      sessionId: "registration-race-session",
    });
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      maxConcurrentRuns: 1,
      resolveDefinition: async () => ({
        agent: new Agent({name: "abort-agent", instructions: "Wait for cancellation."}),
        runtime,
      }),
    });
    await coordinator.handleStoreNotificationStatus("listening");
    await coordinator.start(TEST_RUN_OWNER);

    const submitted = await coordinator.submitInput(thread.id, {
      message: stringToUserMessage("start"),
      source: "tui",
    });
    await store.claimEntered.promise;
    await coordinator.handleStoreNotification({
      kind: "thread_runnable",
      threadId: thread.id,
    });
    store.releaseClaim.resolve();
    await coordinator.waitForCurrentRun(thread.id);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const runs = await store.listRuns(thread.id);
    const [run] = runs;
    expect(run).toMatchObject({
      status: "failed",
      error: "abort committed before controller registration",
    });
    expect(runs).toHaveLength(1);
    expect(store.tryStartRunCalls).toBe(1);
    expect((await store.getInput(submitted.input.id)).status).toBe("pending");
    expect(runtime.complete).not.toHaveBeenCalled();
    expect(store.abortReconciliationReads).toBe(1);

    // Startup/reconnect reconciliation is authoritative and must still leave
    // the input dormant after abort; only a new wake may re-arm it.
    await coordinator.handleStoreNotificationStatus("reconnecting");
    await coordinator.handleStoreNotificationStatus("listening");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.listRuns(thread.id)).toHaveLength(1);
    expect((await store.getInput(submitted.input.id)).deliveryMode).toBe("wake");
    await expect(store.hasPendingWake(thread.id)).resolves.toBe(false);
    await coordinator.stop();
  });

  it("restarts an aborted lane only when a new durable wake arrives after its claim", async () => {
    const store = new GatedRegistrationRaceStore();
    const runtime: LlmRuntime = {
      complete: vi.fn(async () => ({
        role: "assistant" as const,
        content: [{type: "text" as const, text: "processed after abort"}],
        stopReason: "stop" as const,
        timestamp: Date.now(),
      })),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test.");
      }),
    };
    const thread = await store.createThread({
      id: "registration-new-wake-thread",
      sessionId: "registration-new-wake-session",
    });
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      maxConcurrentRuns: 1,
      resolveDefinition: async () => ({
        agent: new Agent({name: "abort-agent", instructions: "Reply briefly."}),
        runtime,
      }),
    });
    await coordinator.handleStoreNotificationStatus("listening");
    await coordinator.start(TEST_RUN_OWNER);

    const first = await coordinator.submitInput(thread.id, {
      message: stringToUserMessage("first"),
      source: "tui",
    });
    await store.claimEntered.promise;
    const second = await coordinator.submitInput(thread.id, {
      message: stringToUserMessage("second"),
      source: "telegram",
    });
    store.releaseClaim.resolve();

    await coordinator.waitForIdle(thread.id);

    expect((await store.getInput(first.input.id)).status).toBe("applied");
    expect((await store.getInput(second.input.id)).status).toBe("applied");
    expect((await store.listRuns(thread.id)).map((run) => run.status)).toEqual([
      "failed",
      "completed",
    ]);
    expect(runtime.complete).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it("does not create a run for a stale runnable notification", async () => {
    const store = new AbortReadCountingStore();
    const thread = await store.createThread({
      id: "stale-runnable-thread",
      sessionId: "stale-runnable-session",
    });
    const runtime = new AbortableRuntime();
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      maxConcurrentRuns: 1,
      resolveDefinition: async () => ({
        agent: new Agent({name: "abort-agent", instructions: "Do not run."}),
        runtime,
      }),
    });
    await coordinator.handleStoreNotificationStatus("listening");
    await coordinator.start(TEST_RUN_OWNER);

    await coordinator.handleStoreNotification({
      kind: "thread_runnable",
      threadId: thread.id,
    });
    await coordinator.waitForIdle(thread.id);

    expect(await store.listRuns(thread.id)).toEqual([]);
    expect(runtime.complete).not.toHaveBeenCalled();
    await coordinator.stop();
  });

  it("reconciles a real wake that commits during a stale no-claim attempt", async () => {
    const store = new GatedNoClaimStore();
    const thread = await store.createThread({
      id: "no-claim-race-thread",
      sessionId: "no-claim-race-session",
    });
    const runtime: LlmRuntime = {
      complete: vi.fn(async () => ({
        role: "assistant" as const,
        content: [{type: "text" as const, text: "processed after no-claim"}],
        stopReason: "stop" as const,
        timestamp: Date.now(),
      })),
      stream: vi.fn(() => {
        throw new Error("Streaming was not expected in this test.");
      }),
    };
    const coordinator = new ThreadRuntimeCoordinator({
      store,
      maxConcurrentRuns: 1,
      resolveDefinition: async () => ({
        agent: new Agent({name: "no-claim-agent", instructions: "Reply briefly."}),
        runtime,
      }),
    });
    await coordinator.handleStoreNotificationStatus("listening");
    await coordinator.start(TEST_RUN_OWNER);

    await coordinator.handleStoreNotification({
      kind: "thread_runnable",
      threadId: thread.id,
    });
    await store.claimEntered.promise;
    const submitted = await coordinator.submitInput(thread.id, {
      message: stringToUserMessage("arrived during stale claim"),
      source: "tui",
    });
    store.releaseClaim.resolve();

    await coordinator.waitForIdle(thread.id);

    expect((await store.getInput(submitted.input.id)).status).toBe("applied");
    expect((await store.listRuns(thread.id)).map((run) => run.status)).toEqual(["completed"]);
    expect(runtime.complete).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it("aborts the local run immediately after persisting the request", async () => {
    const harness = await createHarness();

    expect(await harness.coordinator.abort(harness.thread.id, "stop locally")).toBe(true);

    await waitFor(async () => {
      expect((await harness.store.getRun(harness.run.id)).status).toBe("failed");
    });
    expect((await harness.store.getRun(harness.run.id)).error).toContain("stop locally");
    await harness.coordinator.stop();
  });

  it("delivers a remote abort through the typed notification seam", async () => {
    const harness = await createHarness();
    await harness.store.requestRunAbort(harness.thread.id, "stop remotely");
    const readsBeforeNotification = harness.store.abortReconciliationReads;

    await harness.coordinator.handleStoreNotification({
      kind: "run_abort_requested",
      threadId: harness.thread.id,
      runId: harness.run.id,
    });
    expect(harness.store.abortReconciliationReads).toBe(readsBeforeNotification + 1);

    await waitFor(async () => {
      expect((await harness.store.getRun(harness.run.id)).status).toBe("failed");
    });
    expect((await harness.store.getRun(harness.run.id)).error).toContain("stop remotely");
    await harness.coordinator.stop();
  });

  it("retries a targeted abort read failure without waiting for LISTEN to reconnect", async () => {
    const harness = await createHarness();
    vi.useFakeTimers();
    try {
      await harness.store.requestRunAbort(harness.thread.id, "retry targeted notification");
      harness.store.abortReconciliationFailures = 1;

      await expect(harness.coordinator.handleStoreNotification({
        kind: "run_abort_requested",
        threadId: harness.thread.id,
        runId: harness.run.id,
      })).rejects.toThrow("abort reconciliation read failed");

      await vi.waitFor(() => {
        expect(harness.signal.aborted).toBe(true);
      });
      const readsAfterSuccessfulRetry = harness.store.abortReconciliationReads;
      expect(readsAfterSuccessfulRetry).toBeGreaterThanOrEqual(3);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.store.abortReconciliationReads).toBe(readsAfterSuccessfulRetry);
    } finally {
      await harness.coordinator.stop();
      vi.useRealTimers();
    }
  });

  it("reconciles a missed abort while the listener is unhealthy", async () => {
    const harness = await createHarness();
    await harness.store.requestRunAbort(harness.thread.id, "missed notification");

    await harness.coordinator.handleStoreNotificationStatus("reconnecting");

    await waitFor(async () => {
      expect((await harness.store.getRun(harness.run.id)).status).toBe("failed");
    });
    expect((await harness.store.getRun(harness.run.id)).error).toContain("missed notification");
    await harness.coordinator.stop();
  });

  it("retains a reconnecting listener state received before coordinator start", async () => {
    vi.useFakeTimers();
    let harness: Awaited<ReturnType<typeof createHarness>> | undefined;
    try {
      harness = await createHarness(new AbortReadCountingStore(), "reconnecting");
      await harness.store.requestRunAbort(harness.thread.id, "missed before daemon start");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.signal.aborted).toBe(true);
    } finally {
      await harness?.coordinator.stop();
      vi.useRealTimers();
    }
  });

  it("keeps fallback reconciliation alive until the reconnect read succeeds", async () => {
    const harness = await createHarness();
    vi.useFakeTimers();
    try {
      const readsBeforeDisconnect = harness.store.abortReconciliationReads;
      await harness.coordinator.handleStoreNotificationStatus("reconnecting");
      await vi.waitFor(() => {
        expect(harness.store.abortReconciliationReads).toBe(readsBeforeDisconnect + 1);
      });

      harness.store.abortReconciliationFailures = 1;
      await expect(harness.coordinator.handleStoreNotificationStatus("listening"))
        .rejects.toThrow("abort reconciliation read failed");
      await harness.store.requestRunAbort(harness.thread.id, "missed during failed reconnect");

      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.signal.aborted).toBe(true);
    } finally {
      await harness.coordinator.stop();
      vi.useRealTimers();
    }
  });

  it("does not let a stale listening callback disable reconnect fallback", async () => {
    const harness = await createHarness();
    vi.useFakeTimers();
    try {
      const staleRead = createDeferred<void>();
      const readsBeforeStateChanges = harness.store.abortReconciliationReads;
      harness.store.nextAbortReconciliationGate = staleRead.promise;
      const staleListening = harness.coordinator.handleStoreNotificationStatus("listening");
      await Promise.resolve();
      expect(harness.store.abortReconciliationReads).toBe(readsBeforeStateChanges + 1);

      await harness.coordinator.handleStoreNotificationStatus("reconnecting");
      await Promise.resolve();
      expect(harness.store.abortReconciliationReads).toBe(readsBeforeStateChanges + 2);
      staleRead.resolve();
      await staleListening;

      await harness.store.requestRunAbort(harness.thread.id, "abort during reconnect");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.signal.aborted).toBe(true);
    } finally {
      await harness.coordinator.stop();
      vi.useRealTimers();
    }
  });

  it("does not let a stale reconnecting sweep disable fallback after a newer confirmation fails", async () => {
    const harness = await createHarness();
    const staleSweep = createDeferred<void>();
    vi.useFakeTimers();
    try {
      const readsBeforeReconnect = harness.store.abortReconciliationReads;
      harness.store.nextAbortReconciliationGate = staleSweep.promise;
      await harness.coordinator.handleStoreNotificationStatus("reconnecting");
      await vi.waitFor(() => {
        expect(harness.store.abortReconciliationReads).toBe(readsBeforeReconnect + 1);
      });

      harness.store.abortReconciliationFailures = 1;
      await expect(harness.coordinator.handleStoreNotificationStatus("listening"))
        .rejects.toThrow("abort reconciliation read failed");
      await harness.store.requestRunAbort(harness.thread.id, "abort after failed confirmation");

      staleSweep.resolve();
      await Promise.resolve();
      expect(harness.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(harness.signal.aborted).toBe(true);
    } finally {
      staleSweep.resolve();
      await harness.coordinator.stop();
      vi.useRealTimers();
    }
  });

  it("delivers a requested abort even if the durable run becomes terminal before confirmation", async () => {
    const harness = await createHarness();
    await harness.store.requestRunAbort(harness.thread.id, "abort before terminal transition");
    await harness.store.failRun(harness.run.id, "terminalized by remote recovery");

    await harness.coordinator.handleStoreNotification({
      kind: "run_abort_requested",
      threadId: harness.thread.id,
      runId: harness.run.id,
    });

    expect(harness.signal.aborted).toBe(true);
    await harness.coordinator.stop();
  });

  it("does not start reconciliation when the listener is intentionally closed", async () => {
    const harness = await createHarness();
    vi.useFakeTimers();
    try {
      const readsBeforeClose = harness.store.abortReconciliationReads;
      await harness.coordinator.handleStoreNotificationStatus("closed");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(harness.store.abortReconciliationReads).toBe(readsBeforeClose);
    } finally {
      await harness.coordinator.stop();
      vi.useRealTimers();
    }
  });

  it("waits for an in-flight abort confirmation before shutdown completes", async () => {
    const harness = await createHarness();
    const readGate = createDeferred<void>();
    harness.store.nextAbortReconciliationGate = readGate.promise;
    const notification = harness.coordinator.handleStoreNotification({
      kind: "run_abort_requested",
      threadId: harness.thread.id,
      runId: harness.run.id,
    });
    await waitFor(() => {
      expect(harness.store.nextAbortReconciliationGate).toBeUndefined();
    });

    let stopped = false;
    const stop = harness.coordinator.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    readGate.resolve();
    await notification;
    await stop;
    expect(stopped).toBe(true);
  });

  it("bounds shutdown when an abort reconciliation read never returns", async () => {
    const harness = await createHarness(new AbortReadCountingStore(), "listening", 10);
    const readGate = createDeferred<void>();
    harness.store.nextAbortReconciliationGate = readGate.promise;
    const notification = harness.coordinator.handleStoreNotification({
      kind: "run_abort_requested",
      threadId: harness.thread.id,
      runId: harness.run.id,
    });
    void notification.catch(() => undefined);
    await waitFor(() => {
      expect(harness.store.nextAbortReconciliationGate).toBeUndefined();
    });

    await expect(Promise.race([
      harness.coordinator.stop().then(() => "stopped"),
      new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 250)),
    ])).resolves.toBe("stopped");

    readGate.resolve();
    await notification;
  });

  it("ignores stale run notifications without querying abort state", async () => {
    const harness = await createHarness();
    const readsBeforeNotification = harness.store.abortReconciliationReads;

    await harness.coordinator.handleStoreNotification({
      kind: "run_abort_requested",
      threadId: harness.thread.id,
      runId: "97b2a90c-cbc4-419c-a853-57edb45463e1",
    });
    await harness.coordinator.handleStoreNotification({
      kind: "run_abort_requested",
      threadId: "wrong-thread",
      runId: harness.run.id,
    });

    expect(harness.signal.aborted).toBe(false);
    expect(harness.store.abortReconciliationReads).toBe(readsBeforeNotification);
    await harness.coordinator.abort(harness.thread.id, "test cleanup");
    await waitFor(async () => {
      expect((await harness.store.getRun(harness.run.id)).status).toBe("failed");
    });
    await harness.coordinator.stop();
  });

  it("does not re-read an abort echoed after local cancellation", async () => {
    const harness = await createHarness();
    await harness.coordinator.abort(harness.thread.id, "local echo");
    const readsBeforeNotification = harness.store.abortReconciliationReads;

    await harness.coordinator.handleStoreNotification({
      kind: "run_abort_requested",
      threadId: harness.thread.id,
      runId: harness.run.id,
    });

    expect(harness.store.abortReconciliationReads).toBe(readsBeforeNotification);
    await waitFor(async () => {
      expect((await harness.store.getRun(harness.run.id)).status).toBe("failed");
    });
    await harness.coordinator.stop();
  });

  it("keeps the first durable abort reason across duplicate requests", async () => {
    const harness = await createHarness();

    await harness.coordinator.abort(harness.thread.id, "first reason");
    await harness.coordinator.abort(harness.thread.id, "second reason");

    await waitFor(async () => {
      expect((await harness.store.getRun(harness.run.id)).status).toBe("failed");
    });
    const failedRun = await harness.store.getRun(harness.run.id);
    expect(failedRun.abortReason).toBe("first reason");
    expect(failedRun.error).toContain("first reason");
    expect(failedRun.error).not.toContain("second reason");
    await harness.coordinator.stop();
  });

  it("performs no periodic abort reads while notifications are healthy", async () => {
    const harness = await createHarness();
    const readsAfterRegistration = harness.store.abortReconciliationReads;

    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(harness.store.abortReconciliationReads).toBe(readsAfterRegistration);
    await harness.coordinator.abort(harness.thread.id, "test cleanup");
    await waitFor(async () => {
      expect((await harness.store.getRun(harness.run.id)).status).toBe("failed");
    });
    await harness.coordinator.stop();
  });
});
