import {randomUUID} from "node:crypto";

import type {LlmModelCallObservation, LlmModelCallObserver} from "../../kernel/agent/runtime.js";
import {isRecord} from "../../lib/records.js";
import {
  buildSanitizedModelCallSnapshot,
  sanitizeBoundedPromptCacheKey,
  sanitizeTraceError,
} from "./redaction.js";
import type {
  ModelCallAttemptWrite,
  ModelCallFailure,
  ModelCallRequestShape,
  ModelCallUsage,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const METADATA_QUEUE_BYTES = 512;
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_FLUSH_INTERVAL_MS = 50;
const DEFAULT_MAX_QUEUE_ITEMS = 1_024;
const DEFAULT_MAX_QUEUE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1_000;
const DEFAULT_MAINTENANCE_BATCH_SIZE = 1_000;
const DEFAULT_MAINTENANCE_MAX_BATCHES = 10;
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 5_000;
const BACKPRESSURE_LOG_INTERVAL_MS = 60_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const MAINTENANCE_CATCHUP_DELAY_MS = 1_000;
const MIN_SNAPSHOT_BYTES = 16 * 1024;
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const MAX_CONTEXT_SECTIONS_INSPECTED = 256;

export const DEFAULT_MODEL_CALL_ATTEMPT_RETENTION_DAYS = 90;
export const DEFAULT_MODEL_CALL_SNAPSHOT_RETENTION_DAYS = 7;
export const DEFAULT_MODEL_CALL_SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MODEL_CALL_SUCCESS_SNAPSHOT_SAMPLE_RATE = 0;

export interface ModelCallAttemptSink {
  insertAttempts(attempts: readonly ModelCallAttemptWrite[]): Promise<void>;
  purgeExpiredBatch(now: number, limit: number): Promise<number>;
}

export interface ModelCallRecorderOptions {
  sink: ModelCallAttemptSink;
  attemptRetentionDays?: number;
  snapshotRetentionDays?: number;
  snapshotMaxBytes?: number;
  successSnapshotSampleRate?: number;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueueItems?: number;
  maxQueueBytes?: number;
  maintenanceIntervalMs?: number;
  maintenanceBatchSize?: number;
  maintenanceMaxBatches?: number;
  shutdownDrainTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
  createId?: () => string;
  log?: (event: string, details: Record<string, unknown>) => void;
}

export interface ModelCallRecorderStats {
  queuedItems: number;
  queuedBytes: number;
  writtenAttempts: number;
  writtenSnapshots: number;
  droppedAttempts: number;
  droppedSnapshots: number;
  writeFailures: number;
}

interface PendingObservation {
  write: ModelCallAttemptWrite;
  snapshotInput?: LlmModelCallObservation;
  queueBytes: number;
}

interface PreparedAttempt {
  write: ModelCallAttemptWrite;
  queueBytes: number;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1) throw new Error(`${label} must be a positive integer.`);
  return resolved;
}

function retentionDays(value: number | undefined, fallback: number, label: string): number {
  return positiveInteger(value, fallback, label);
}

function sampleRate(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MODEL_CALL_SUCCESS_SNAPSHOT_SAMPLE_RATE;
  if (!Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error("Model call success snapshot sample rate must be between 0 and 1.");
  }
  return resolved;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function finiteNonNegativeInteger(value: unknown): number {
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(finiteNonNegative(value)));
}

function sumFiniteNonNegative(values: readonly unknown[]): number {
  let total = 0;
  for (const value of values) total = Math.min(Number.MAX_VALUE, total + finiteNonNegative(value));
  return total;
}

function postgresNonNegativeInteger(value: number): number {
  return Math.min(POSTGRES_INTEGER_MAX, Math.max(0, Math.trunc(value)));
}

function readUsage(input: LlmModelCallObservation): ModelCallUsage | undefined {
  if (!input.response || !isRecord(input.response.usage)) return undefined;
  const usage = input.response.usage;
  const cost: Record<string, unknown> = isRecord(usage.cost) ? usage.cost : {};
  const inputTokens = finiteNonNegativeInteger(usage.input);
  const outputTokens = finiteNonNegativeInteger(usage.output);
  const cacheReadTokens = finiteNonNegativeInteger(usage.cacheRead);
  const cacheWriteTokens = finiteNonNegativeInteger(usage.cacheWrite);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens: finiteNonNegativeInteger(usage.totalTokens)
      || Math.min(Number.MAX_SAFE_INTEGER, inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens),
    inputCost: finiteNonNegative(cost.input),
    outputCost: finiteNonNegative(cost.output),
    cacheReadCost: finiteNonNegative(cost.cacheRead),
    cacheWriteCost: finiteNonNegative(cost.cacheWrite),
    totalCost: finiteNonNegative(cost.total)
      || sumFiniteNonNegative([cost.input, cost.output, cost.cacheRead, cost.cacheWrite]),
  };
}

function readFailure(error: unknown): ModelCallFailure | undefined {
  if (error === undefined) return undefined;
  const sanitized = sanitizeTraceError(error);
  const category = typeof sanitized.category === "string" ? sanitized.category : "Error";
  const message = typeof sanitized.message === "string" ? sanitized.message : "Model call failed.";
  const status = typeof sanitized.status === "number"
    && Number.isInteger(sanitized.status)
    && sanitized.status >= 0
    && sanitized.status <= POSTGRES_INTEGER_MAX
    ? sanitized.status
    : undefined;
  return {
    category,
    message,
    ...(typeof sanitized.provider === "string" ? {provider: sanitized.provider} : {}),
    ...(typeof sanitized.model === "string" ? {model: sanitized.model} : {}),
    ...(status === undefined ? {} : {status}),
    ...(typeof sanitized.retryable === "boolean" ? {retryable: sanitized.retryable} : {}),
    ...(typeof sanitized.timedOut === "boolean" ? {timedOut: sanitized.timedOut} : {}),
    ...(typeof sanitized.stopReason === "string" ? {stopReason: sanitized.stopReason} : {}),
  };
}

function requestShape(input: LlmModelCallObservation): ModelCallRequestShape {
  const request = input.request;
  const sections = request.trace?.llmContextSections ?? [];
  let contextChars = 0;
  for (let index = 0; index < Math.min(sections.length, MAX_CONTEXT_SECTIONS_INSPECTED); index += 1) {
    const section = sections[index]!;
    contextChars = Math.min(
      POSTGRES_INTEGER_MAX,
      contextChars + postgresNonNegativeInteger(section.dumpChars ?? section.contentChars ?? 0),
    );
  }
  return {
    systemPromptChars: postgresNonNegativeInteger(request.context.systemPrompt?.length ?? 0),
    messageCount: postgresNonNegativeInteger(request.context.messages.length),
    toolCount: postgresNonNegativeInteger(request.context.tools?.length ?? 0),
    contextSectionCount: postgresNonNegativeInteger(sections.length),
    contextChars,
  };
}

function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${key} must be a positive integer.`);
  return parsed;
}

export function resolveModelCallRecorderConfig(env: NodeJS.ProcessEnv = process.env): Pick<
  ModelCallRecorderOptions,
  "attemptRetentionDays" | "snapshotRetentionDays" | "snapshotMaxBytes" | "successSnapshotSampleRate"
> {
  const rateRaw = env.PANDA_MODEL_CALL_SUCCESS_SNAPSHOT_SAMPLE_RATE?.trim();
  const rate = rateRaw ? Number(rateRaw) : DEFAULT_MODEL_CALL_SUCCESS_SNAPSHOT_SAMPLE_RATE;
  return {
    attemptRetentionDays: readPositiveIntegerEnv(
      env,
      "PANDA_MODEL_CALL_ATTEMPT_RETENTION_DAYS",
      DEFAULT_MODEL_CALL_ATTEMPT_RETENTION_DAYS,
    ),
    snapshotRetentionDays: readPositiveIntegerEnv(
      env,
      "PANDA_MODEL_CALL_SNAPSHOT_RETENTION_DAYS",
      DEFAULT_MODEL_CALL_SNAPSHOT_RETENTION_DAYS,
    ),
    snapshotMaxBytes: readPositiveIntegerEnv(
      env,
      "PANDA_MODEL_CALL_SNAPSHOT_MAX_BYTES",
      DEFAULT_MODEL_CALL_SNAPSHOT_MAX_BYTES,
    ),
    successSnapshotSampleRate: sampleRate(rate),
  };
}

function defaultLog(event: string, details: Record<string, unknown>): void {
  console.error(event, details);
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Bounded best-effort flight recorder. The public observation method performs
 * no I/O and never returns a promise; all expensive snapshot work is deferred.
 */
export class BufferedModelCallRecorder implements LlmModelCallObserver {
  private readonly sink: ModelCallAttemptSink;
  private readonly attemptRetentionMs: number;
  private readonly snapshotRetentionMs: number;
  private readonly snapshotMaxBytes: number;
  private readonly successSnapshotSampleRate: number;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxQueueItems: number;
  private readonly maxQueueBytes: number;
  private readonly maintenanceIntervalMs: number;
  private readonly maintenanceBatchSize: number;
  private readonly maintenanceMaxBatches: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly createId: () => string;
  private readonly log: (event: string, details: Record<string, unknown>) => void;
  private readonly observationQueue: PendingObservation[] = [];
  private readonly writeQueue: PreparedAttempt[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private maintenanceCatchupTimer: NodeJS.Timeout | null = null;
  private maintenancePromise: Promise<void> | null = null;
  private preparePromise: Promise<void> | null = null;
  private writePromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;
  private closeStartedAt: number | null = null;
  private closed = false;
  private queuedBytes = 0;
  private inFlightItems = 0;
  private writtenAttempts = 0;
  private writtenSnapshots = 0;
  private droppedAttempts = 0;
  private droppedSnapshots = 0;
  private writeFailures = 0;
  private backpressureDirty = false;
  private lastBackpressureLogAt = Number.NEGATIVE_INFINITY;
  private lastFailureLogAt = Number.NEGATIVE_INFINITY;
  private suppressedFailureLogs = 0;

  constructor(options: ModelCallRecorderOptions) {
    this.sink = options.sink;
    this.attemptRetentionMs = retentionDays(
      options.attemptRetentionDays,
      DEFAULT_MODEL_CALL_ATTEMPT_RETENTION_DAYS,
      "Model call attempt retention days",
    ) * DAY_MS;
    this.snapshotRetentionMs = retentionDays(
      options.snapshotRetentionDays,
      DEFAULT_MODEL_CALL_SNAPSHOT_RETENTION_DAYS,
      "Model call snapshot retention days",
    ) * DAY_MS;
    this.snapshotMaxBytes = positiveInteger(
      options.snapshotMaxBytes,
      DEFAULT_MODEL_CALL_SNAPSHOT_MAX_BYTES,
      "Model call snapshot max bytes",
    );
    if (this.snapshotMaxBytes < MIN_SNAPSHOT_BYTES) {
      throw new Error(`Model call snapshot max bytes must be at least ${MIN_SNAPSHOT_BYTES}.`);
    }
    if (this.snapshotRetentionMs > this.attemptRetentionMs) {
      throw new Error("Model call snapshot retention cannot exceed attempt retention.");
    }
    this.successSnapshotSampleRate = sampleRate(options.successSnapshotSampleRate);
    this.batchSize = positiveInteger(options.batchSize, DEFAULT_BATCH_SIZE, "Model call recorder batch size");
    this.flushIntervalMs = positiveInteger(
      options.flushIntervalMs,
      DEFAULT_FLUSH_INTERVAL_MS,
      "Model call recorder flush interval",
    );
    this.maxQueueItems = positiveInteger(
      options.maxQueueItems,
      DEFAULT_MAX_QUEUE_ITEMS,
      "Model call recorder max queue items",
    );
    this.maxQueueBytes = positiveInteger(
      options.maxQueueBytes,
      DEFAULT_MAX_QUEUE_BYTES,
      "Model call recorder max queue bytes",
    );
    if (this.snapshotMaxBytes > this.maxQueueBytes) {
      throw new Error("Model call snapshot max bytes cannot exceed the recorder queue byte budget.");
    }
    this.maintenanceIntervalMs = positiveInteger(
      options.maintenanceIntervalMs,
      DEFAULT_MAINTENANCE_INTERVAL_MS,
      "Model call recorder maintenance interval",
    );
    this.maintenanceBatchSize = positiveInteger(
      options.maintenanceBatchSize,
      DEFAULT_MAINTENANCE_BATCH_SIZE,
      "Model call recorder maintenance batch size",
    );
    this.maintenanceMaxBatches = positiveInteger(
      options.maintenanceMaxBatches,
      DEFAULT_MAINTENANCE_MAX_BATCHES,
      "Model call recorder maintenance max batches",
    );
    this.shutdownDrainTimeoutMs = positiveInteger(
      options.shutdownDrainTimeoutMs,
      DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS,
      "Model call recorder shutdown drain timeout",
    );
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.createId = options.createId ?? randomUUID;
    this.log = options.log ?? defaultLog;
  }

  start(): void {
    if (this.closed || this.maintenanceTimer) return;
    this.maintenanceTimer = setInterval(() => {
      this.beginMaintenance();
    }, this.maintenanceIntervalMs);
    this.maintenanceTimer.unref?.();
  }

  observeModelCall(input: LlmModelCallObservation): void {
    if (this.closed) {
      this.droppedAttempts += 1;
      return;
    }

    const finishedAt = input.finishedAt;
    const captureSnapshot = input.error !== undefined || this.random() < this.successSnapshotSampleRate;
    const usage = readUsage(input);
    const failure = readFailure(input.error);
    const write: ModelCallAttemptWrite = {
      id: this.createId(),
      runId: input.request.metadata?.runId,
      threadId: input.request.metadata?.threadId,
      sessionId: input.request.metadata?.sessionId,
      agentKey: input.request.metadata?.agentKey,
      turn: input.request.metadata?.turn,
      attempt: input.attempt,
      provider: input.request.providerName,
      model: input.request.modelId,
      mode: input.mode,
      status: input.error === undefined ? "completed" : "failed",
      startedAt: input.startedAt,
      finishedAt,
      durationMs: Math.max(0, Math.trunc(finishedAt - input.startedAt)),
      ...(input.request.promptCacheKey === undefined
        ? {}
        : {promptCacheKey: sanitizeBoundedPromptCacheKey(input.request.promptCacheKey)}),
      ...(usage ? {usage} : {}),
      ...(failure ? {failure} : {}),
      requestShape: requestShape(input),
      snapshotStatus: captureSnapshot ? "captured" : "not_captured",
      expiresAt: finishedAt + this.attemptRetentionMs,
    };

    let pending: PendingObservation = {
      write,
      ...(captureSnapshot ? {snapshotInput: input} : {}),
      queueBytes: captureSnapshot ? this.snapshotMaxBytes : METADATA_QUEUE_BYTES,
    };
    if (this.queuedBytes + pending.queueBytes > this.maxQueueBytes && pending.snapshotInput) {
      this.droppedSnapshots += 1;
      this.backpressureDirty = true;
      pending = {
        write: {...write, snapshotStatus: "dropped"},
        queueBytes: METADATA_QUEUE_BYTES,
      };
    }
    if (this.queuedItems() >= this.maxQueueItems || this.queuedBytes + pending.queueBytes > this.maxQueueBytes) {
      this.droppedAttempts += 1;
      this.backpressureDirty = true;
      return;
    }

    this.observationQueue.push(pending);
    this.queuedBytes += pending.queueBytes;
    this.beginPrepare();
  }

  snapshotStats(): ModelCallRecorderStats {
    return {
      queuedItems: this.queuedItems(),
      queuedBytes: this.queuedBytes,
      writtenAttempts: this.writtenAttempts,
      writtenSnapshots: this.writtenSnapshots,
      droppedAttempts: this.droppedAttempts,
      droppedSnapshots: this.droppedSnapshots,
      writeFailures: this.writeFailures,
    };
  }

  async flush(): Promise<void> {
    this.clearFlushTimer();
    while (this.observationQueue.length > 0 || this.preparePromise || this.writeQueue.length > 0 || this.writePromise) {
      this.beginPrepare();
      const prepare = this.preparePromise;
      if (prepare) await prepare;
      this.beginDrain();
      const drain = this.writePromise;
      if (drain) await drain;
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closeStartedAt = Date.now();
    this.closePromise = (async () => {
      this.clearFlushTimer();
      if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
      if (this.maintenanceCatchupTimer) clearTimeout(this.maintenanceCatchupTimer);
      this.maintenanceCatchupTimer = null;
      await this.maintenancePromise;
      await this.flush();
    })();
    return this.closePromise;
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.writePromise || this.writeQueue.length === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.beginDrain();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  private beginDrain(): void {
    this.clearFlushTimer();
    if (this.writePromise || this.writeQueue.length === 0) return;
    this.writePromise = this.writeLoop()
      .catch((error) => {
        this.writeFailures += 1;
        this.reportFailure("model_call_recorder_write_failed", error);
      })
      .finally(() => {
        this.reportBackpressure();
        this.writePromise = null;
        if (this.writeQueue.length > 0) this.scheduleFlush();
      });
  }

  private beginPrepare(): void {
    if (this.preparePromise || this.observationQueue.length === 0) return;
    // Cross an event-loop boundary before touching request content. This keeps
    // observation constant-time even when a full batch arrives at once.
    this.preparePromise = yieldToEventLoop()
      .then(() => this.prepareLoop())
      .catch((error) => {
        this.reportFailure("model_call_snapshot_prepare_failed", error);
      })
      .finally(() => {
        this.preparePromise = null;
        if (this.observationQueue.length > 0) this.beginPrepare();
        if (this.writeQueue.length >= this.batchSize || this.closed) this.beginDrain();
        else this.scheduleFlush();
      });
  }

  private async prepareLoop(): Promise<void> {
    while (this.observationQueue.length > 0) {
      if (this.shutdownDrainExpired()) {
        this.dropQueuedAttempts();
        return;
      }
      const pending = this.observationQueue.splice(0, this.batchSize);
      for (const item of pending) {
        let write = item.write;
        let queueBytes = item.queueBytes;
        if (item.snapshotInput) {
          try {
            const snapshot = buildSanitizedModelCallSnapshot(item.snapshotInput, this.snapshotMaxBytes);
            write = {
              ...write,
              snapshotStatus: snapshot.truncated ? "truncated" : "captured",
              snapshot: {
                requestJson: snapshot.requestJson,
                responseJson: snapshot.responseJson,
                bytes: snapshot.bytes,
                truncated: snapshot.truncated,
                expiresAt: write.finishedAt + this.snapshotRetentionMs,
              },
            };
            queueBytes = Math.min(item.queueBytes, Math.max(METADATA_QUEUE_BYTES, snapshot.bytes));
          } catch (error) {
            this.droppedSnapshots += 1;
            write = {...write, snapshotStatus: "dropped"};
            queueBytes = METADATA_QUEUE_BYTES;
            this.reportFailure("model_call_snapshot_build_failed", error, {
              attemptId: write.id,
            });
          }
          await yieldToEventLoop();
        }
        this.queuedBytes -= item.queueBytes - queueBytes;
        this.writeQueue.push({write, queueBytes});
      }
      if (this.writeQueue.length >= this.batchSize) this.beginDrain();
      await yieldToEventLoop();
    }
  }

  private async writeLoop(): Promise<void> {
    while (this.writeQueue.length > 0) {
      if (this.shutdownDrainExpired()) {
        this.dropQueuedAttempts();
        return;
      }
      const pending = this.writeQueue.splice(0, this.batchSize);
      const writes = pending.map((item) => item.write);
      const batchBytes = pending.reduce((total, item) => total + item.queueBytes, 0);
      this.inFlightItems += writes.length;

      try {
        await this.sink.insertAttempts(writes);
        this.writtenAttempts += writes.length;
        this.writtenSnapshots += writes.filter((write) => write.snapshot).length;
      } catch (error) {
        this.writeFailures += 1;
        this.droppedAttempts += writes.length;
        this.reportFailure("model_call_recorder_batch_dropped", error, {
          attempts: writes.length,
        });
        if (this.closed) {
          this.dropQueuedAttempts();
          return;
        }
      } finally {
        this.inFlightItems -= writes.length;
        this.queuedBytes -= batchBytes;
      }
    }
  }

  private async runMaintenance(): Promise<boolean> {
    try {
      for (let index = 0; index < this.maintenanceMaxBatches; index += 1) {
        const deleted = await this.sink.purgeExpiredBatch(this.now(), this.maintenanceBatchSize);
        if (deleted < this.maintenanceBatchSize) return false;
        await yieldToEventLoop();
      }
      return true;
    } catch (error) {
      this.reportFailure("model_call_recorder_maintenance_failed", error);
      return false;
    }
  }

  private beginMaintenance(): void {
    if (this.closed || this.maintenancePromise) return;
    this.maintenancePromise = this.runMaintenance()
      .then((moreExpiredRows) => {
        if (!moreExpiredRows || this.closed || this.maintenanceCatchupTimer) return;
        this.maintenanceCatchupTimer = setTimeout(() => {
          this.maintenanceCatchupTimer = null;
          this.beginMaintenance();
        }, MAINTENANCE_CATCHUP_DELAY_MS);
        this.maintenanceCatchupTimer.unref?.();
      })
      .finally(() => {
        this.maintenancePromise = null;
      });
  }

  private reportBackpressure(): void {
    if (!this.backpressureDirty) return;
    const now = this.now();
    if (now - this.lastBackpressureLogAt < BACKPRESSURE_LOG_INTERVAL_MS) return;
    this.backpressureDirty = false;
    this.lastBackpressureLogAt = now;
    this.emitLog("model_call_recorder_backpressure", {
      droppedAttempts: this.droppedAttempts,
      droppedSnapshots: this.droppedSnapshots,
      maxQueueItems: this.maxQueueItems,
      maxQueueBytes: this.maxQueueBytes,
    });
  }

  private shutdownDrainExpired(): boolean {
    return this.closeStartedAt !== null
      && Date.now() - this.closeStartedAt >= this.shutdownDrainTimeoutMs;
  }

  private dropQueuedAttempts(): void {
    const droppedItems = this.observationQueue.length + this.writeQueue.length;
    this.droppedAttempts += droppedItems;
    this.queuedBytes -= this.observationQueue.reduce((total, item) => total + item.queueBytes, 0);
    this.queuedBytes -= this.writeQueue.reduce((total, item) => total + item.queueBytes, 0);
    this.observationQueue.length = 0;
    this.writeQueue.length = 0;
    this.backpressureDirty = true;
  }

  private queuedItems(): number {
    return this.observationQueue.length + this.writeQueue.length + this.inFlightItems;
  }

  private emitLog(event: string, details: Record<string, unknown>): void {
    try {
      this.log(event, details);
    } catch {
      // Telemetry logging is part of the same best-effort boundary as writes.
    }
  }

  private reportFailure(event: string, error: unknown, details: Record<string, unknown> = {}): void {
    const now = this.now();
    if (now - this.lastFailureLogAt < FAILURE_LOG_INTERVAL_MS) {
      this.suppressedFailureLogs += 1;
      return;
    }
    const suppressedSinceLast = this.suppressedFailureLogs;
    this.suppressedFailureLogs = 0;
    this.lastFailureLogAt = now;
    this.emitLog(event, {
      ...details,
      message: error instanceof Error ? error.message : String(error),
      ...(suppressedSinceLast > 0 ? {suppressedSinceLast} : {}),
    });
  }
}
