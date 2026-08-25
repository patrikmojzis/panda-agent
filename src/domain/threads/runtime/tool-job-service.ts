import {randomUUID} from "node:crypto";

import {ToolError} from "../../../kernel/agent/exceptions.js";
import {withFallbackTimeout} from "../../../lib/async.js";
import type {JsonObject} from "../../../lib/json.js";
import type {ThreadRuntimeStore} from "./store.js";
import type {
  ThreadRunOwner,
  ThreadToolJobKind,
  ThreadToolJobRecord,
  ThreadToolJobStatus,
  ThreadToolJobUpdate,
} from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
const DEFAULT_CANCEL_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_SHUTDOWN_SETTLE_TIMEOUT_MS = 5_000;

export interface BackgroundToolJobSnapshot {
  status?: ThreadToolJobStatus;
  summary?: string;
  result?: JsonObject | null;
  error?: string | null;
  statusReason?: string | null;
  progress?: JsonObject | null;
  finishedAt?: number;
  durationMs?: number;
}

export interface BackgroundToolJobCompletion extends BackgroundToolJobSnapshot {
  status?: Exclude<ThreadToolJobStatus, "running">;
}

export interface BackgroundToolJobHandle {
  startedAt?: number;
  progress?: JsonObject;
  result?: JsonObject;
  done: Promise<BackgroundToolJobCompletion | void>;
  snapshot?: () => BackgroundToolJobSnapshot | Promise<BackgroundToolJobSnapshot | void> | void;
  cancel?: (reason?: string) => BackgroundToolJobSnapshot | Promise<BackgroundToolJobSnapshot | void> | void;
}

export interface BackgroundToolJobStartContext {
  jobId: string;
  signal: AbortSignal;
  emitProgress(progress: JsonObject): void;
}

export interface BackgroundToolJobStartOptions {
  threadId: string;
  runId?: string;
  kind: ThreadToolJobKind;
  summary: string;
  start(context: BackgroundToolJobStartContext): Promise<BackgroundToolJobHandle> | BackgroundToolJobHandle;
}

export type BackgroundToolJobTerminalHandler = (record: ThreadToolJobRecord) => Promise<void> | void;

interface LiveToolJob {
  controller: AbortController;
  handle: BackgroundToolJobHandle;
}

interface StartingToolJob {
  controller: AbortController;
  reservation: Promise<ThreadToolJobRecord>;
  startupSettled: Promise<void>;
  resolveStartupSettled(): void;
}

function createStartingToolJob(
  controller: AbortController,
  reservation: Promise<ThreadToolJobRecord>,
): StartingToolJob {
  let resolveStartupSettled!: () => void;
  const startupSettled = new Promise<void>((resolve) => {
    resolveStartupSettled = resolve;
  });
  return {controller, reservation, startupSettled, resolveStartupSettled};
}

function isTerminalStatus(status: ThreadToolJobStatus | undefined): boolean {
  return status !== undefined && status !== "running";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): string {
  const reason = signal.reason;
  return reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Cancelled.";
}

function snapshotToUpdate(snapshot: BackgroundToolJobSnapshot): ThreadToolJobUpdate {
  const update: ThreadToolJobUpdate = {};
  if (snapshot.status !== undefined) {
    update.status = snapshot.status;
  }
  if (snapshot.summary !== undefined) {
    update.summary = snapshot.summary;
  }
  if (snapshot.result !== undefined) {
    update.result = snapshot.result;
  }
  if (snapshot.error !== undefined) {
    update.error = snapshot.error;
  }
  if (snapshot.statusReason !== undefined) {
    update.statusReason = snapshot.statusReason;
  }
  if (snapshot.progress !== undefined) {
    update.progress = snapshot.progress;
  }
  if (snapshot.finishedAt !== undefined) {
    update.finishedAt = snapshot.finishedAt;
  }
  if (snapshot.durationMs !== undefined) {
    update.durationMs = snapshot.durationMs;
  }
  return update;
}

export class BackgroundToolJobService {
  private readonly store: Pick<
    ThreadRuntimeStore,
    "createToolJob" | "getToolJob" | "listToolJobs" | "updateToolJob"
  >;
  private readonly liveJobs = new Map<string, LiveToolJob>();
  private readonly startingJobs = new Map<string, StartingToolJob>();
  private readonly quietJobIds = new Set<string>();
  private readonly shutdownSettleTimeoutMs: number;
  private onTerminalJob?: BackgroundToolJobTerminalHandler;
  private owner: ThreadRunOwner | null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: {
    store: Pick<ThreadRuntimeStore, "createToolJob" | "getToolJob" | "listToolJobs" | "updateToolJob">;
    owner?: ThreadRunOwner;
    shutdownSettleTimeoutMs?: number;
  }) {
    this.store = options.store;
    this.owner = options.owner ? {...options.owner} : null;
    this.shutdownSettleTimeoutMs = options.shutdownSettleTimeoutMs ?? DEFAULT_SHUTDOWN_SETTLE_TIMEOUT_MS;
    if (!Number.isInteger(this.shutdownSettleTimeoutMs) || this.shutdownSettleTimeoutMs <= 0) {
      throw new Error("Background tool job shutdown timeout must be a positive integer.");
    }
  }

  setOwner(owner: ThreadRunOwner | null): void {
    this.owner = owner ? {...owner} : null;
  }

  setBackgroundCompletionHandler(handler?: BackgroundToolJobTerminalHandler): void {
    this.onTerminalJob = handler;
  }

  async start(options: BackgroundToolJobStartOptions): Promise<ThreadToolJobRecord> {
    if (this.closed) {
      throw new Error("Background tool job service is closed.");
    }
    const owner = options.runId ? undefined : this.owner ?? undefined;
    if (!options.runId && !owner) {
      throw new Error("Standalone background work requires an active daemon lease.");
    }
    const jobId = randomUUID();
    const controller = new AbortController();
    let lastProgress: JsonObject | undefined;

    const emitProgress = (progress: JsonObject): void => {
      lastProgress = progress;
      void this.store.updateToolJob(jobId, {progress}).catch(() => undefined);
    };

    // Register before the first await. Shutdown must own the whole reservation
    // handshake, otherwise a delayed INSERT could return after lease release
    // and start an untracked external process.
    const reservation = Promise.resolve().then(() => this.store.createToolJob({
      id: jobId,
      threadId: options.threadId,
      runId: options.runId,
      owner,
      kind: options.kind,
      summary: options.summary,
      startedAt: Date.now(),
    }));
    const starting = createStartingToolJob(controller, reservation);
    this.startingJobs.set(jobId, starting);

    let record: ThreadToolJobRecord;
    try {
      record = await reservation;
    } catch (error) {
      this.startingJobs.delete(jobId);
      starting.resolveStartupSettled();
      throw error;
    }
    if (this.closed || controller.signal.aborted) {
      try {
        return await this.cancelStartingJobRecord(jobId, starting);
      } finally {
        this.startingJobs.delete(jobId);
        starting.resolveStartupSettled();
      }
    }

    let handle: BackgroundToolJobHandle;
    try {
      handle = await options.start({
        jobId,
        signal: controller.signal,
        emitProgress,
      });
    } catch (error) {
      try {
        await this.store.updateToolJob(jobId, {
          status: controller.signal.aborted ? "cancelled" : "failed",
          finishedAt: Date.now(),
          error: controller.signal.aborted ? null : errorMessage(error),
          statusReason: controller.signal.aborted
            ? abortReason(controller.signal)
            : "Background tool job failed to start.",
        });
      } catch (persistError) {
        throw new AggregateError(
          [error, persistError],
          "Background tool job failed to start and its durable record could not be settled.",
        );
      } finally {
        this.startingJobs.delete(jobId);
        starting.resolveStartupSettled();
      }
      throw error;
    }

    if (this.closed || controller.signal.aborted) {
      try {
        // Some adapters cannot interrupt handle acquisition. Once they do
        // return, shutdown still owns that handle and must cancel it before
        // the daemon lease can be released.
        controller.abort(new Error("Runtime shutdown."));
        await handle.cancel?.("Runtime shutdown.");
        return await this.cancelStartingJobRecord(jobId, starting);
      } finally {
        this.startingJobs.delete(jobId);
        starting.resolveStartupSettled();
      }
    }

    this.startingJobs.delete(jobId);
    starting.resolveStartupSettled();
    this.liveJobs.set(jobId, {controller, handle});

    try {
      const initialProgress = lastProgress ?? handle.progress;
      record = await this.store.updateToolJob(jobId, {
        ...(handle.startedAt !== undefined ? {startedAt: handle.startedAt} : {}),
        ...(initialProgress ? {progress: initialProgress} : {}),
        ...(handle.result ? {result: handle.result} : {}),
      });
    } catch (error) {
      this.liveJobs.delete(jobId);
      controller.abort(error);
      await handle.cancel?.("Background tool job ownership was lost before startup completed.");
      throw error;
    }

    if (record.status !== "running" || this.closed) {
      this.liveJobs.delete(jobId);
      controller.abort(new Error("Runtime shutdown."));
      await handle.cancel?.("Runtime shutdown.");
      return record;
    }

    void this.watchJob(jobId);
    return record;
  }

  async status(threadId: string, jobId: string): Promise<ThreadToolJobRecord> {
    const record = await this.requireJob(threadId, jobId);
    if (isTerminalStatus(record.status)) {
      return record;
    }

    return this.readLiveJob(record);
  }

  async wait(threadId: string, jobId: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<ThreadToolJobRecord> {
    const record = await this.requireJob(threadId, jobId);
    if (isTerminalStatus(record.status)) {
      return record;
    }

    const live = this.liveJobs.get(jobId);
    if (!live) {
      const latest = await this.store.getToolJob(jobId);
      return isTerminalStatus(latest.status)
        ? latest
        : this.markLost(latest, "Live background tool job state was missing.");
    }

    try {
      const completion = await withFallbackTimeout(live.handle.done, timeoutMs, () => null);
      if (!completion) {
        return this.readLiveJob(record);
      }

      return this.finalizeJob(record, this.normalizeCompletion(record, completion, live.controller.signal));
    } catch (error) {
      return this.finalizeJob(record, this.errorCompletion(error, live.controller.signal));
    }
  }

  async cancel(threadId: string, jobId: string): Promise<ThreadToolJobRecord> {
    const record = await this.requireJob(threadId, jobId);
    if (isTerminalStatus(record.status)) {
      this.quietJobIds.delete(jobId);
      return record;
    }

    const live = this.liveJobs.get(jobId);
    if (!live) {
      const latest = await this.store.getToolJob(jobId);
      return isTerminalStatus(latest.status)
        ? latest
        : this.markLost(latest, "Live background tool job state was missing.");
    }

    live.controller.abort(new Error("Cancelled by background_job_cancel."));
    const cancelSnapshot = await live.handle.cancel?.("Cancelled by background_job_cancel.");
    if (cancelSnapshot && isTerminalStatus(cancelSnapshot.status)) {
      return this.finalizeJob(record, cancelSnapshot);
    }

    return this.wait(threadId, jobId, DEFAULT_CANCEL_WAIT_TIMEOUT_MS);
  }

  async cancelThreadJobs(threadId: string): Promise<void> {
    const jobs = await this.store.listToolJobs(threadId);

    const runningJobIds = jobs
      .filter((job) => job.status === "running")
      .map((job) => job.id);
    for (const jobId of runningJobIds) {
      this.quietJobIds.add(jobId);
    }

    // Reset must not claim the old thread is retired while an external job is
    // still running. Any authoritative listing/cancellation failure leaves the
    // durable reset request retryable behind its run-admission fence.
    await Promise.all(runningJobIds.map((jobId) => this.cancel(threadId, jobId)));
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = (async () => {
      const jobs = [...this.liveJobs.entries()];
      const startingJobs = [...this.startingJobs.entries()];
      for (const [jobId, starting] of startingJobs) {
        this.quietJobIds.add(jobId);
        starting.controller.abort(new Error("Runtime shutdown."));
      }
      for (const [jobId, live] of jobs) {
        this.quietJobIds.add(jobId);
        live.controller.abort(new Error("Runtime shutdown."));
      }

      // Cooperative jobs settle durably while the daemon lease is still held.
      // A non-cooperative external process gets only this bounded grace; later
      // writes are rejected by the immutable owner tuple after lease release.
      const settlement = Promise.allSettled([
        ...startingJobs.map(([jobId, starting]) => this.settleStartingJobForShutdown(jobId, starting)),
        ...jobs.map(([jobId, live]) => this.settleJobForShutdown(jobId, live)),
      ]);
      await withFallbackTimeout(settlement, this.shutdownSettleTimeoutMs, () => null);
    })();
    return this.closePromise;
  }

  private async settleStartingJobForShutdown(
    jobId: string,
    starting: StartingToolJob,
  ): Promise<ThreadToolJobRecord> {
    const record = await this.cancelStartingJobRecord(jobId, starting);
    await starting.startupSettled;
    return record;
  }

  private async cancelStartingJobRecord(
    jobId: string,
    starting: StartingToolJob,
  ): Promise<ThreadToolJobRecord> {
    const record = await starting.reservation;
    const finishedAt = Date.now();
    return this.store.updateToolJob(jobId, {
      status: "cancelled",
      finishedAt,
      durationMs: Math.max(0, finishedAt - record.startedAt),
      error: null,
      statusReason: "Runtime shutdown.",
    });
  }

  private async settleJobForShutdown(jobId: string, live: LiveToolJob): Promise<void> {
    let record: ThreadToolJobRecord;
    try {
      record = await this.store.getToolJob(jobId);
    } catch {
      return;
    }
    if (record.status !== "running") {
      this.liveJobs.delete(jobId);
      return;
    }

    try {
      const cancelled = await live.handle.cancel?.("Runtime shutdown.");
      if (cancelled && isTerminalStatus(cancelled.status)) {
        await this.finalizeJob(record, cancelled);
        return;
      }
      const completion = await live.handle.done;
      await this.finalizeJob(record, this.normalizeCompletion(record, completion, live.controller.signal));
    } catch (error) {
      await this.finalizeJob(record, this.errorCompletion(error, live.controller.signal));
    }
  }

  private async requireJob(threadId: string, jobId: string): Promise<ThreadToolJobRecord> {
    let record: ThreadToolJobRecord;
    try {
      record = await this.store.getToolJob(jobId);
    } catch {
      throw new ToolError(`Unknown background job ${jobId}.`);
    }

    if (record.threadId !== threadId) {
      throw new ToolError("Background jobs are only available inside the thread that created them.");
    }

    return record;
  }

  private async readLiveJob(record: ThreadToolJobRecord): Promise<ThreadToolJobRecord> {
    const live = this.liveJobs.get(record.id);
    if (!live) {
      const latest = await this.store.getToolJob(record.id);
      return isTerminalStatus(latest.status)
        ? latest
        : this.markLost(latest, "Live background tool job state was missing.");
    }

    const snapshot = await live.handle.snapshot?.();
    if (!snapshot) {
      return record;
    }

    if (isTerminalStatus(snapshot.status)) {
      return this.finalizeJob(record, snapshot);
    }

    const update = snapshotToUpdate(snapshot);
    return Object.keys(update).length > 0
      ? this.store.updateToolJob(record.id, update)
      : record;
  }

  private async watchJob(jobId: string): Promise<void> {
    const live = this.liveJobs.get(jobId);
    if (!live) {
      return;
    }

    try {
      const record = await this.store.getToolJob(jobId);
      if (record.status !== "running") {
        return;
      }

      const completion = await live.handle.done;
      await this.finalizeJob(record, this.normalizeCompletion(record, completion, live.controller.signal), {
        notify: true,
      });
    } catch (error) {
      try {
        const record = await this.store.getToolJob(jobId);
        if (record.status === "running") {
          await this.finalizeJob(record, this.errorCompletion(error, live.controller.signal), {
            notify: true,
          });
        }
      } catch {
        // Ignore missing jobs during shutdown races.
      }
    }
  }

  private normalizeCompletion(
    record: ThreadToolJobRecord,
    completion: BackgroundToolJobCompletion | void,
    signal: AbortSignal,
  ): BackgroundToolJobSnapshot {
    const finishedAt = completion?.finishedAt ?? Date.now();
    const status = completion?.status ?? (signal.aborted ? "cancelled" : "completed");
    return {
      ...completion,
      status,
      finishedAt,
      durationMs: completion?.durationMs ?? Math.max(0, finishedAt - record.startedAt),
      ...(status === "cancelled" && !completion?.statusReason ? {statusReason: abortReason(signal)} : {}),
    };
  }

  private errorCompletion(error: unknown, signal: AbortSignal): BackgroundToolJobSnapshot {
    const cancelled = signal.aborted;
    return {
      status: cancelled ? "cancelled" : "failed",
      finishedAt: Date.now(),
      error: cancelled ? null : errorMessage(error),
      statusReason: cancelled ? abortReason(signal) : undefined,
    };
  }

  private async finalizeJob(
    record: ThreadToolJobRecord,
    snapshot: BackgroundToolJobSnapshot,
    options: { notify?: boolean } = {},
  ): Promise<ThreadToolJobRecord> {
    const current = await this.store.getToolJob(record.id);
    if (current.status !== "running") {
      this.liveJobs.delete(record.id);
      this.quietJobIds.delete(record.id);
      return current;
    }

    const finishedAt = snapshot.finishedAt ?? Date.now();
    const updated = await this.store.updateToolJob(record.id, {
      ...snapshotToUpdate(snapshot),
      status: snapshot.status ?? "completed",
      finishedAt,
      durationMs: snapshot.durationMs ?? Math.max(0, finishedAt - record.startedAt),
    });
    const notify = options.notify === true && !this.quietJobIds.has(record.id);
    this.liveJobs.delete(record.id);
    this.quietJobIds.delete(record.id);
    if (notify) {
      await this.onTerminalJob?.(updated);
    }
    return updated;
  }

  private async markLost(record: ThreadToolJobRecord, reason: string): Promise<ThreadToolJobRecord> {
    const finishedAt = Date.now();
    const updated = await this.store.updateToolJob(record.id, {
      status: "lost",
      finishedAt,
      durationMs: Math.max(0, finishedAt - record.startedAt),
      statusReason: reason,
    });
    this.liveJobs.delete(record.id);
    this.quietJobIds.delete(record.id);
    return updated;
  }
}
