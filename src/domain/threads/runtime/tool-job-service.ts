import {randomUUID} from "node:crypto";

import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {JsonObject} from "../../../kernel/agent/types.js";
import type {ThreadRuntimeStore} from "./store.js";
import type {ThreadToolJobKind, ThreadToolJobRecord, ThreadToolJobStatus, ThreadToolJobUpdate,} from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_CANCEL_WAIT_TIMEOUT_MS = 1_000;

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: () => T): Promise<T> {
  if (timeoutMs <= 0) {
    return Promise.resolve(fallback());
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(fallback());
    }, timeoutMs);
    timer.unref();

    promise.then((value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(value);
    }).catch((error) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
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
  private readonly quietJobIds = new Set<string>();
  private onTerminalJob?: BackgroundToolJobTerminalHandler;

  constructor(options: {
    store: Pick<ThreadRuntimeStore, "createToolJob" | "getToolJob" | "listToolJobs" | "updateToolJob">;
  }) {
    this.store = options.store;
  }

  setBackgroundCompletionHandler(handler?: BackgroundToolJobTerminalHandler): void {
    this.onTerminalJob = handler;
  }

  async start(options: BackgroundToolJobStartOptions): Promise<ThreadToolJobRecord> {
    const jobId = randomUUID();
    const controller = new AbortController();
    let lastProgress: JsonObject | undefined;
    let recordCreated = false;

    const emitProgress = (progress: JsonObject): void => {
      lastProgress = progress;
      if (recordCreated) {
        void this.store.updateToolJob(jobId, {progress}).catch(() => undefined);
      }
    };

    const handle = await options.start({
      jobId,
      signal: controller.signal,
      emitProgress,
    });

    let record: ThreadToolJobRecord;
    try {
      record = await this.store.createToolJob({
        id: jobId,
        threadId: options.threadId,
        runId: options.runId,
        kind: options.kind,
        summary: options.summary,
        startedAt: handle.startedAt,
        progress: lastProgress ?? handle.progress,
        result: handle.result,
      });
      recordCreated = true;
    } catch (error) {
      controller.abort(error);
      await handle.cancel?.("Background tool job could not be persisted.");
      throw error;
    }

    this.liveJobs.set(jobId, {
      controller,
      handle,
    });
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
      const completion = await withTimeout(live.handle.done, timeoutMs, () => null);
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
    let jobs: readonly ThreadToolJobRecord[];
    try {
      jobs = await this.store.listToolJobs(threadId);
    } catch {
      return;
    }

    const runningJobIds = jobs
      .filter((job) => job.status === "running")
      .map((job) => job.id);
    for (const jobId of runningJobIds) {
      this.quietJobIds.add(jobId);
    }

    await Promise.all(runningJobIds.map(async (jobId) => {
      try {
        await this.cancel(threadId, jobId);
      } catch {
        // Reset-driven cleanup is best effort. Keep the thread replacement moving.
      }
    }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.liveJobs.entries()].map(async ([jobId, live]) => {
      this.quietJobIds.add(jobId);
      live.controller.abort(new Error("Runtime shutdown."));
      await live.handle.cancel?.("Runtime shutdown.");
    }));
    this.liveJobs.clear();
    this.quietJobIds.clear();
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
