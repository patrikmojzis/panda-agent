import {randomUUID} from "node:crypto";

type SchedulerState = "idle" | "running" | "stopping" | "closed";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ScheduledWork<T = unknown> {
  threadId: string;
  kind: "run" | "exclusive";
  priority: "interactive" | "backlog" | "control";
  runId: string | null;
  execute(signal: AbortSignal): Promise<T>;
  deferred: Deferred<T>;
  controller: AbortController | null;
  admissionUncertain: boolean;
  admissionFailures: number;
  admissionRetryAt: number | null;
  admissionRetryStartedAt: number | null;
}

export interface ThreadRunSchedulerOptions {
  maxConcurrentRuns: number;
  maxInteractiveBurst?: number;
  shutdownDrainTimeoutMs?: number;
  run(threadId: string, signal: AbortSignal, runId: string): Promise<ThreadRunAttemptResult>;
  onAttemptSettled?(threadId: string, result: ThreadRunAttemptResult): Promise<void> | void;
  onAdmissionRetry?(retry: ThreadRunAdmissionRetry): Promise<void> | void;
  onAdmissionShutdown?(
    threadId: string,
    runId: string,
    reason: unknown,
  ): Promise<void> | void;
  onExclusiveSettled?(threadId: string): Promise<void> | void;
  onCapacityAvailable?(): Promise<void> | void;
  onError?(threadId: string, error: unknown): Promise<void> | void;
}

export type ThreadRunAttemptResult =
  | {outcome: "completed" | "aborted" | "no_claim" | "claim_lost" | "stopped"}
  | {outcome: "admission_failed"; error: unknown};

export interface ThreadRunAdmissionRetry {
  threadId: string;
  error: unknown;
  attempt: number;
  delayMs: number;
}

export interface ThreadRunSchedulerSnapshot {
  active: number;
  queued: number;
  retrying: number;
  oldestAdmissionRetryAgeMs: number;
  maxConcurrentRuns: number;
}

const ADMISSION_RETRY_INITIAL_DELAY_MS = 100;
const ADMISSION_RETRY_MAX_DELAY_MS = 5_000;

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, resolve, reject};
}

function requireMaxConcurrentRuns(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("Thread run concurrency must be a positive integer.");
  }
  return value;
}

function requireShutdownDrainTimeout(value: number | undefined): number {
  const resolved = value ?? 30_000;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error("Thread run shutdown drain timeout must be a positive integer.");
  }
  return resolved;
}

function requireMaxInteractiveBurst(value: number | undefined): number {
  const resolved = value ?? 8;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new Error("Thread run interactive burst must be a positive integer.");
  }
  return resolved;
}

function admissionRetryDelayMs(attempt: number): number {
  const exponent = Math.min(Math.max(0, attempt - 1), 30);
  const ceiling = Math.min(
    ADMISSION_RETRY_INITIAL_DELAY_MS * (2 ** exponent),
    ADMISSION_RETRY_MAX_DELAY_MS,
  );
  // Equal jitter prevents several daemons recovering from the same outage from
  // synchronizing their claim attempts while retaining a meaningful floor.
  return Math.ceil((ceiling / 2) + (Math.random() * ceiling / 2));
}

/**
 * Owns process-local thread serialization and global run backpressure.
 *
 * Durable inputs remain the source of truth. This scheduler only decides when
 * the current daemon may attempt them; it never turns Postgres pool capacity
 * into an implicit execution queue.
 */
export class ThreadRunScheduler {
  private readonly maxConcurrentRuns: number;
  private readonly maxInteractiveBurst: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly runThread: (
    threadId: string,
    signal: AbortSignal,
    runId: string,
  ) => Promise<ThreadRunAttemptResult>;
  private readonly onAttemptSettled?: (
    threadId: string,
    result: ThreadRunAttemptResult,
  ) => Promise<void> | void;
  private readonly onAdmissionRetry?: (retry: ThreadRunAdmissionRetry) => Promise<void> | void;
  private readonly onAdmissionShutdown?: (
    threadId: string,
    runId: string,
    reason: unknown,
  ) => Promise<void> | void;
  private readonly onExclusiveSettled?: (threadId: string) => Promise<void> | void;
  private readonly onCapacityAvailable?: () => Promise<void> | void;
  private readonly onError?: (threadId: string, error: unknown) => Promise<void> | void;
  private readonly queue: ScheduledWork[] = [];
  private readonly admissionRetryQueue: Array<ScheduledWork<ThreadRunAttemptResult>> = [];
  private readonly queuedByThreadId = new Map<string, ScheduledWork>();
  private readonly activeByThreadId = new Map<string, ScheduledWork>();
  private readonly settlingByThreadId = new Map<string, Set<ScheduledWork>>();
  private readonly exclusiveAfterActive = new Map<string, ScheduledWork>();
  private readonly runAfterExclusive = new Map<string, ScheduledWork<ThreadRunAttemptResult>>();
  private readonly rerunRequested = new Set<string>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly lastErrors = new Map<string, unknown>();
  private state: SchedulerState = "idle";
  private drainQueued = false;
  private interactiveStartsSinceBacklog = 0;
  private admissionRetryTimer: NodeJS.Timeout | undefined;
  private shutdownReason: unknown;
  private stopPromise: Promise<void> | null = null;

  constructor(options: ThreadRunSchedulerOptions) {
    this.maxConcurrentRuns = requireMaxConcurrentRuns(options.maxConcurrentRuns);
    this.maxInteractiveBurst = requireMaxInteractiveBurst(options.maxInteractiveBurst);
    this.shutdownDrainTimeoutMs = requireShutdownDrainTimeout(options.shutdownDrainTimeoutMs);
    this.runThread = options.run;
    this.onAttemptSettled = options.onAttemptSettled;
    this.onAdmissionRetry = options.onAdmissionRetry;
    this.onAdmissionShutdown = options.onAdmissionShutdown;
    this.onExclusiveSettled = options.onExclusiveSettled;
    this.onCapacityAvailable = options.onCapacityAvailable;
    this.onError = options.onError;
  }

  getSnapshot(): ThreadRunSchedulerSnapshot {
    const retryStartedAt = this.admissionRetryQueue.reduce<number | null>((oldest, work) => {
      if (work.admissionRetryStartedAt === null) {
        return oldest;
      }
      return oldest === null
        ? work.admissionRetryStartedAt
        : Math.min(oldest, work.admissionRetryStartedAt);
    }, null);
    return {
      active: this.activeByThreadId.size,
      queued: this.queuedByThreadId.size,
      retrying: this.admissionRetryQueue.length,
      oldestAdmissionRetryAgeMs: retryStartedAt === null ? 0 : Math.max(0, Date.now() - retryStartedAt),
      maxConcurrentRuns: this.maxConcurrentRuns,
    };
  }

  start(): void {
    if (this.state === "running") {
      return;
    }
    if (this.state !== "idle") {
      throw new Error("Thread run scheduler cannot be restarted after shutdown.");
    }

    this.state = "running";
    this.kick();
  }

  schedule(threadId: string, priority: "interactive" | "backlog" = "interactive"): void {
    if (this.state === "closed" || this.state === "stopping") {
      return;
    }
    const queued = this.queuedByThreadId.get(threadId);
    if (queued) {
      if (queued.kind === "exclusive") {
        this.rerunRequested.add(threadId);
      } else if (priority === "interactive" && queued.priority === "backlog") {
        const index = this.queue.indexOf(queued);
        queued.priority = "interactive";
        if (index >= 0) {
          this.queue.splice(index, 1);
          this.insertRunWork(queued);
        }
        // Delayed admission work is not in the runnable queue yet. Updating the
        // work in place preserves the retry deadline and upgrades its eventual
        // queue position without creating a second lane for the thread.
      }
      return;
    }
    if (this.activeByThreadId.has(threadId)) {
      // A notification that arrives while work is active represents durable
      // state that may outlive a failed run or exclusive operation. Retain one
      // follow-up attempt; Postgres rejects it cheaply if nothing remains.
      this.rerunRequested.add(threadId);
      return;
    }

    const deferred = createDeferred<ThreadRunAttemptResult>();
    const runId = randomUUID();
    // Scheduling is intentionally fire-and-forget. Callers that need the result
    // observe the same promise through waitForCurrentRun/waitForIdle.
    void deferred.promise.catch(() => undefined);
    const work: ScheduledWork<ThreadRunAttemptResult> = {
      threadId,
      kind: "run",
      priority,
      runId,
      // The run id is also the admission idempotency key. Retrying this same
      // work must reconcile an ambiguously committed claim rather than create a
      // fresh claim identity and mistake the committed row for another owner.
      execute: (signal) => this.runThread(threadId, signal, runId),
      deferred,
      controller: null,
      admissionUncertain: false,
      admissionFailures: 0,
      admissionRetryAt: null,
      admissionRetryStartedAt: null,
    };
    this.insertRunWork(work);
    this.queuedByThreadId.set(threadId, work);
    this.kick();
  }

  async runExclusively<T>(
    threadId: string,
    operation: (signal: AbortSignal) => Promise<T>,
    options: {
      abortActiveReason?: unknown;
      beforeActiveAbort?: () => Promise<void>;
    } = {},
  ): Promise<T> {
    if (this.state !== "running") {
      throw new Error("Thread runtime is not running.");
    }
    const queued = this.queuedByThreadId.get(threadId);
    const active = this.activeByThreadId.get(threadId);
    if (active?.kind === "exclusive" || queued?.kind === "exclusive" || this.exclusiveAfterActive.has(threadId)) {
      throw new Error("Thread already has an exclusive operation in progress.");
    }

    const deferred = createDeferred<T>();
    let activeAbortPreparation: Promise<void> | undefined;
    const work: ScheduledWork<T> = {
      threadId,
      kind: "exclusive",
      priority: "control",
      runId: null,
      execute: async (signal) => {
        await activeAbortPreparation;
        return operation(signal);
      },
      deferred,
      controller: null,
      admissionUncertain: false,
      admissionFailures: 0,
      admissionRetryAt: null,
      admissionRetryStartedAt: null,
    };
    if (active) {
      // Reserving the lane closes the reset/compaction race: no queued run can
      // slip between the current run settling and the exclusive operation.
      this.exclusiveAfterActive.set(threadId, work);
      this.queuedByThreadId.set(threadId, work);
      if (options.abortActiveReason !== undefined) {
        activeAbortPreparation = (async () => {
          // The lane is already reserved, but the active run stays alive until
          // its durable abort is recorded. If the run settles first, the
          // exclusive operation still observes the same completed preparation.
          await options.beforeActiveAbort?.();
          active.controller?.abort(options.abortActiveReason);
        })();
        // Execution awaits and reports this error once the active lane drains.
        // Attach a handler now so a fast DB failure is never unhandled.
        void activeAbortPreparation.catch(() => undefined);
      }
    } else if (queued) {
      // The run hint still represents durable work. If exclusive work fails,
      // it must not disappear merely because it won the process-local lane.
      this.removeQueuedWork(queued);
      const admissionRetry = queued.kind === "run" && queued.admissionUncertain
        ? queued as ScheduledWork<ThreadRunAttemptResult>
        : null;
      if (admissionRetry) {
        // A delayed admission may represent a committed claim whose response
        // was lost. Preserve the exact work/run id across control work instead
        // of replacing it with a fresh, non-idempotent admission identity.
        this.runAfterExclusive.set(threadId, admissionRetry);
      } else {
        this.rerunRequested.add(threadId);
        queued.deferred.reject(new Error("Thread run was superseded by exclusive work."));
      }
      // Control work must not inherit a deep startup-backlog position.
      this.queue.unshift(work);
      this.queuedByThreadId.set(threadId, work);
    } else {
      this.queue.unshift(work);
      this.queuedByThreadId.set(threadId, work);
    }
    this.kick();
    return deferred.promise;
  }

  abort(threadId: string, reason: unknown): boolean {
    const active = this.activeByThreadId.get(threadId);
    if (!active?.controller) {
      return false;
    }
    active.controller.abort(reason);
    return true;
  }

  isBusy(threadId: string): boolean {
    return this.queuedByThreadId.has(threadId)
      || this.activeByThreadId.has(threadId)
      || this.settlingByThreadId.has(threadId);
  }

  async waitForCurrent(threadId: string): Promise<void> {
    const work = this.getThreadWork(threadId);
    if (work) {
      await work.deferred.promise;
    }
  }

  async waitForIdle(threadId: string): Promise<void> {
    let observedError: unknown;
    while (true) {
      const work = this.getThreadWork(threadId);
      if (!work) {
        const error = this.lastErrors.get(threadId) ?? observedError;
        if (error !== undefined) {
          throw error;
        }
        return;
      }
      try {
        await work.deferred.promise;
        observedError = undefined;
      } catch (error) {
        observedError = error;
        // Failure may already have admitted a coalesced successor. The idle
        // contract covers the whole lane; surface the last error only after no
        // queued, active, or settling work remains.
      }
    }
  }

  stop(reason: unknown = new Error("Thread runtime stopped.")): Promise<void> {
    this.stopPromise ??= this.stopOnce(reason);
    return this.stopPromise;
  }

  private async stopOnce(reason: unknown): Promise<void> {
    if (this.state === "closed") {
      return;
    }
    if (this.state === "idle") {
      this.state = "closed";
      this.rejectQueued(reason);
      return;
    }

    this.state = "stopping";
    this.shutdownReason = reason;
    const queuedAdmissionDrains = this.rejectQueued(reason).map((work) => {
      return this.drainAdmissionOnShutdown(work, reason);
    });
    for (const work of this.activeByThreadId.values()) {
      work.controller?.abort(reason);
    }
    const drainTasks = [...this.activeTasks, ...queuedAdmissionDrains];
    const drained = await this.waitForActiveTasks(drainTasks);
    if (!drained) {
      const activeThreadIds = [...this.activeByThreadId.keys()];
      const error = new Error(
        `Thread runtime shutdown exceeded ${this.shutdownDrainTimeoutMs}ms; abandoning ${drainTasks.length} non-cooperative task(s).`,
      );
      for (const threadId of activeThreadIds) {
        void Promise.resolve(this.onError?.(threadId, error)).catch(() => undefined);
      }
    }
    this.state = "closed";
  }

  private rejectQueued(reason: unknown): Array<ScheduledWork<ThreadRunAttemptResult>> {
    const queued = new Set([
      ...this.queuedByThreadId.values(),
      ...this.runAfterExclusive.values(),
    ]);
    const admissionDrains: Array<ScheduledWork<ThreadRunAttemptResult>> = [];
    this.queue.length = 0;
    this.admissionRetryQueue.length = 0;
    this.clearAdmissionRetryTimer();
    this.exclusiveAfterActive.clear();
    this.runAfterExclusive.clear();
    this.rerunRequested.clear();
    for (const work of queued) {
      this.queuedByThreadId.delete(work.threadId);
      if (work.kind === "run" && work.admissionUncertain && work.runId) {
        admissionDrains.push(work as ScheduledWork<ThreadRunAttemptResult>);
      } else {
        work.deferred.reject(reason);
      }
    }
    return admissionDrains;
  }

  private kick(): void {
    if (this.state !== "running" || this.drainQueued) {
      return;
    }
    this.drainQueued = true;
    queueMicrotask(() => {
      this.drainQueued = false;
      this.drain();
    });
  }

  private drain(): void {
    while (
      this.state === "running"
      && this.activeByThreadId.size < this.maxConcurrentRuns
      && this.queue.length > 0
    ) {
      const work = this.takeNextWork();
      if (!work) {
        return;
      }

      this.queuedByThreadId.delete(work.threadId);
      const controller = new AbortController();
      work.controller = controller;
      this.activeByThreadId.set(work.threadId, work);
      const task = this.execute(work, controller.signal);
      this.activeTasks.add(task);
      void task.finally(() => {
        this.activeTasks.delete(task);
      });
    }
  }

  private async execute(work: ScheduledWork, signal: AbortSignal): Promise<void> {
    let error: unknown;
    let failed = false;
    let result: unknown;
    let retryScheduled = false;
    let admissionRetry: ThreadRunAdmissionRetry | undefined;
    let admissionShutdown: {runId: string; reason: unknown} | undefined;
    try {
      result = await work.execute(signal);
      if (
        work.kind === "exclusive"
        || (result as ThreadRunAttemptResult).outcome === "completed"
      ) {
        this.lastErrors.delete(work.threadId);
      }
    } catch (caught) {
      failed = true;
      error = caught;
      this.lastErrors.set(work.threadId, caught);
      try {
        await this.onError?.(work.threadId, caught);
      } catch {
        // Reporting must never wedge scheduler capacity.
      }
    } finally {
      this.activeByThreadId.delete(work.threadId);
      work.controller = null;
      this.addSettlingWork(work);
      const attemptResult = work.kind === "run" && !failed
        ? result as ThreadRunAttemptResult
        : undefined;
      const admissionFailure = attemptResult?.outcome === "admission_failed"
        ? attemptResult
        : undefined;

      if (
        work.kind === "run"
        && !failed
        && attemptResult?.outcome === "completed"
      ) {
        // A normal run consumes wakes that arrive before its final boundary;
        // the authoritative settlement hook finds only work that raced after
        // it. Replaying every in-run hint would create empty successor runs.
        this.rerunRequested.delete(work.threadId);
      }
      const reservedExclusive = this.exclusiveAfterActive.get(work.threadId);
      if (this.state === "running" && reservedExclusive) {
        if (admissionFailure) {
          // Preserve the exact attempt identity. The failed claim may have
          // committed, so a fresh run id after control work could mistake that
          // owned row for unrelated work and strand it.
          work.admissionUncertain = true;
          this.runAfterExclusive.set(
            work.threadId,
            work as ScheduledWork<ThreadRunAttemptResult>,
          );
          retryScheduled = true;
        }
        this.exclusiveAfterActive.delete(work.threadId);
        this.queue.unshift(reservedExclusive);
      } else if (work.kind === "exclusive") {
        const retainedRun = this.runAfterExclusive.get(work.threadId);
        const rerun = this.rerunRequested.delete(work.threadId);
        if (this.state === "running" && retainedRun) {
          this.runAfterExclusive.delete(work.threadId);
          this.insertRunWork(retainedRun);
          this.queuedByThreadId.set(work.threadId, retainedRun);
        } else if (this.state === "running" && failed && rerun) {
          // Successful callers perform an authoritative reconciliation before
          // returning. Failure has no caller-side reconciliation, so preserve
          // a wake that arrived while the exclusive lane was held.
          this.schedule(work.threadId);
        }
      } else if (admissionFailure) {
        // The original work remains the one process-local lane for this durable
        // wake. Additional NOTIFY hints are already represented by it and must
        // not multiply retries or bypass backoff.
        this.rerunRequested.delete(work.threadId);
        if (this.state === "running") {
          admissionRetry = this.delayAdmissionRetry(
            work as ScheduledWork<ThreadRunAttemptResult>,
            admissionFailure.error,
          );
          retryScheduled = true;
        } else if (this.state === "stopping" && work.runId) {
          // The claim statement has finished, but its error does not prove the
          // transaction rolled back. Shutdown must reconcile this exact id
          // before releasing the daemon owner; it must never start a fresh id.
          work.admissionUncertain = true;
          admissionShutdown = {runId: work.runId, reason: this.shutdownReason};
        }
      } else {
        const rerun = this.rerunRequested.delete(work.threadId);
        // Only an execution failure can lose a wake without an authoritative
        // durable boundary. Abort/claim-loss/no-claim outcomes deliberately
        // leave their input pending; replaying an echoed notification here
        // would create a hot reclaim loop.
        if (this.state === "running" && failed && rerun) {
          this.schedule(work.threadId);
        }
      }

      // Refill execution capacity before reconciliation performs database I/O.
      // Durable state owns correctness; a slow settlement read must not turn
      // the process-local concurrency limit into idle time for unrelated work.
      this.kick();

      if (admissionRetry) {
        const retry = admissionRetry;
        await this.reportSettlementError(
          work.threadId,
          () => this.onAdmissionRetry?.(retry),
        );
      }
      if (admissionShutdown) {
        const shutdown = admissionShutdown;
        await this.reportSettlementError(
          work.threadId,
          () => this.onAdmissionShutdown?.(
            work.threadId,
            shutdown.runId,
            shutdown.reason,
          ),
        );
      }
      if (attemptResult && !admissionFailure) {
        await this.reportSettlementError(
          work.threadId,
          () => this.onAttemptSettled?.(work.threadId, attemptResult),
        );
      }
      if (work.kind === "exclusive" && !failed) {
        await this.reportSettlementError(
          work.threadId,
          () => this.onExclusiveSettled?.(work.threadId),
        );
      }
      await this.reportSettlementError(work.threadId, () => this.onCapacityAvailable?.());
    }

    this.removeSettlingWork(work);
    if (retryScheduled) {
      // The deferred remains unresolved across attempts, so waitForCurrent and
      // waitForIdle cover the entire admission-retry lane rather than exposing
      // a false idle boundary between attempts.
      return;
    }
    if (failed) {
      work.deferred.reject(error);
      // The work promise carries the failure to waiters. The scheduler task
      // itself resolves so one failed thread cannot poison shutdown/draining.
      return;
    }
    work.deferred.resolve(result);
  }

  private delayAdmissionRetry(
    work: ScheduledWork<ThreadRunAttemptResult>,
    error: unknown,
  ): ThreadRunAdmissionRetry {
    const now = Date.now();
    work.admissionUncertain = true;
    work.admissionFailures += 1;
    work.admissionRetryStartedAt ??= now;
    const delayMs = admissionRetryDelayMs(work.admissionFailures);
    work.admissionRetryAt = now + delayMs;
    const insertionIndex = this.admissionRetryQueue.findIndex((queued) => {
      return (queued.admissionRetryAt ?? Number.POSITIVE_INFINITY) > work.admissionRetryAt!;
    });
    if (insertionIndex < 0) {
      this.admissionRetryQueue.push(work);
    } else {
      this.admissionRetryQueue.splice(insertionIndex, 0, work);
    }
    this.queuedByThreadId.set(work.threadId, work);
    this.armAdmissionRetryTimer();
    return {
      threadId: work.threadId,
      error,
      attempt: work.admissionFailures,
      delayMs,
    };
  }

  private async drainAdmissionOnShutdown(
    work: ScheduledWork<ThreadRunAttemptResult>,
    reason: unknown,
  ): Promise<void> {
    try {
      const runId = work.runId;
      if (runId) {
        await this.reportSettlementError(
          work.threadId,
          () => this.onAdmissionShutdown?.(work.threadId, runId, reason),
        );
      }
    } finally {
      work.deferred.reject(reason);
    }
  }

  private armAdmissionRetryTimer(): void {
    this.clearAdmissionRetryTimer();
    const next = this.admissionRetryQueue[0];
    if (!next || next.admissionRetryAt === null || this.state !== "running") {
      return;
    }
    this.admissionRetryTimer = setTimeout(() => {
      this.admissionRetryTimer = undefined;
      this.releaseAdmissionRetries();
    }, Math.max(0, next.admissionRetryAt - Date.now()));
    this.admissionRetryTimer.unref?.();
  }

  private clearAdmissionRetryTimer(): void {
    if (this.admissionRetryTimer) {
      clearTimeout(this.admissionRetryTimer);
      this.admissionRetryTimer = undefined;
    }
  }

  private releaseAdmissionRetries(): void {
    if (this.state !== "running") {
      return;
    }
    const now = Date.now();
    while (true) {
      const work = this.admissionRetryQueue[0];
      if (!work || work.admissionRetryAt === null || work.admissionRetryAt > now) {
        break;
      }
      this.admissionRetryQueue.shift();
      work.admissionRetryAt = null;
      if (this.queuedByThreadId.get(work.threadId) === work) {
        this.insertRunWork(work);
      }
    }
    this.armAdmissionRetryTimer();
    this.kick();
  }

  private removeQueuedWork(work: ScheduledWork): void {
    const queueIndex = this.queue.indexOf(work);
    if (queueIndex >= 0) {
      this.queue.splice(queueIndex, 1);
    }
    const retryIndex = this.admissionRetryQueue.indexOf(
      work as ScheduledWork<ThreadRunAttemptResult>,
    );
    if (retryIndex >= 0) {
      this.admissionRetryQueue.splice(retryIndex, 1);
      work.admissionRetryAt = null;
      work.admissionRetryStartedAt = null;
      this.armAdmissionRetryTimer();
    }
  }

  private getThreadWork(threadId: string): ScheduledWork | undefined {
    return this.activeByThreadId.get(threadId)
      ?? this.queuedByThreadId.get(threadId)
      ?? this.settlingByThreadId.get(threadId)?.values().next().value;
  }

  private addSettlingWork(work: ScheduledWork): void {
    const settling = this.settlingByThreadId.get(work.threadId) ?? new Set<ScheduledWork>();
    settling.add(work);
    this.settlingByThreadId.set(work.threadId, settling);
  }

  private removeSettlingWork(work: ScheduledWork): void {
    const settling = this.settlingByThreadId.get(work.threadId);
    if (!settling) {
      return;
    }
    settling.delete(work);
    if (settling.size === 0) {
      this.settlingByThreadId.delete(work.threadId);
    }
  }

  private async reportSettlementError(
    threadId: string,
    callback: () => Promise<void> | void | undefined,
  ): Promise<void> {
    try {
      await callback();
    } catch (error) {
      try {
        await this.onError?.(threadId, error);
      } catch {
        // Reporting must never wedge scheduler capacity.
      }
    }
  }

  private insertRunWork(work: ScheduledWork): void {
    if (work.priority === "backlog") {
      this.queue.push(work);
      return;
    }
    const firstBacklog = this.queue.findIndex((queued) => queued.priority === "backlog");
    if (firstBacklog < 0) {
      this.queue.push(work);
      return;
    }
    this.queue.splice(firstBacklog, 0, work);
  }

  private takeNextWork(): ScheduledWork | undefined {
    const first = this.queue[0];
    if (!first) {
      return undefined;
    }
    // Control-plane operations retain strict priority. Fairness applies only
    // between interactive traffic and startup/reconnect backlog.
    if (first.priority === "control") {
      return this.queue.shift();
    }

    const backlogIndex = this.queue.findIndex((work) => work.priority === "backlog");
    if (backlogIndex < 0) {
      this.interactiveStartsSinceBacklog = 0;
      return this.queue.shift();
    }
    if (this.interactiveStartsSinceBacklog >= this.maxInteractiveBurst) {
      this.interactiveStartsSinceBacklog = 0;
      return this.queue.splice(backlogIndex, 1)[0];
    }

    const work = this.queue.shift();
    if (work?.priority === "interactive") {
      this.interactiveStartsSinceBacklog += 1;
    } else if (work?.priority === "backlog") {
      this.interactiveStartsSinceBacklog = 0;
    }
    return work;
  }

  private async waitForActiveTasks(tasks: readonly Promise<void>[]): Promise<boolean> {
    if (tasks.length === 0) {
      return true;
    }
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.allSettled(tasks).then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), this.shutdownDrainTimeoutMs);
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
