import type {RuntimeRequestRecord} from "../../domain/threads/requests/types.js";
import {DrainLoop} from "../../lib/drain-loop.js";

export const DEFAULT_RUNTIME_REQUEST_DRAIN_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_RUNTIME_REQUEST_CONCURRENCY = 4;
export const DEFAULT_RUNTIME_REQUEST_CLAIM_RENEW_INTERVAL_MS = 60_000;
export const DEFAULT_RUNTIME_REQUEST_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
export const DEFAULT_COMPLETED_RUNTIME_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_FAILED_RUNTIME_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_RUNTIME_REQUEST_PRUNE_INTERVAL_MS = 60 * 60_000;
export const DEFAULT_RUNTIME_REQUEST_PRUNE_BATCH_SIZE = 500;

export interface RuntimeRequestDrainStore {
  claimNextPendingRequest(): Promise<RuntimeRequestRecord | null>;
  renewRequestClaim(id: string, claimToken: string): Promise<boolean>;
  releaseRequestClaim(id: string, claimToken: string): Promise<boolean>;
  completeRequest(id: string, claimToken: string, result?: unknown): Promise<unknown>;
  failRequest(id: string, claimToken: string, error: string): Promise<unknown>;
  pruneSettledRequests(input: {
    completedBefore: Date;
    failedBefore: Date;
    limit?: number;
  }): Promise<number>;
}

interface RuntimeRequestDrainOptions {
  requests: RuntimeRequestDrainStore;
  processRequest(request: RuntimeRequestRecord, signal: AbortSignal): Promise<unknown>;
  label?: string;
  onError?: (error: unknown) => Promise<void> | void;
  pollIntervalMs?: number;
  claimRenewIntervalMs?: number;
  pruneIntervalMs?: number;
  completedRetentionMs?: number;
  failedRetentionMs?: number;
  pruneBatchSize?: number;
  now?: () => number;
  maxConcurrency?: number;
  shutdownDrainTimeoutMs?: number;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

/**
 * Drains runtime requests behind the lifecycle seam with bounded shutdown.
 */
export class RuntimeRequestDrain {
  private readonly requests: RuntimeRequestDrainStore;
  private readonly processRequest: (request: RuntimeRequestRecord, signal: AbortSignal) => Promise<unknown>;
  private readonly loop: DrainLoop;
  private readonly claimRenewIntervalMs?: number;
  private readonly pruneIntervalMs: number;
  private readonly completedRetentionMs: number;
  private readonly failedRetentionMs: number;
  private readonly pruneBatchSize: number;
  private readonly now: () => number;
  private readonly maxConcurrency: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly onError?: (error: unknown) => Promise<void> | void;
  private readonly active = new Map<Promise<void>, AbortController>();
  private lastPrunedAt = Number.NEGATIVE_INFINITY;
  private stopPromise: Promise<void> | null = null;

  constructor(options: RuntimeRequestDrainOptions) {
    this.requests = options.requests;
    this.processRequest = options.processRequest;
    this.claimRenewIntervalMs = options.claimRenewIntervalMs === undefined
      ? undefined
      : requirePositiveInteger(options.claimRenewIntervalMs, "Runtime request claim renewal interval");
    this.pruneIntervalMs = requirePositiveInteger(
      options.pruneIntervalMs ?? DEFAULT_RUNTIME_REQUEST_PRUNE_INTERVAL_MS,
      "Runtime request prune interval",
    );
    this.completedRetentionMs = requirePositiveInteger(
      options.completedRetentionMs ?? DEFAULT_COMPLETED_RUNTIME_REQUEST_RETENTION_MS,
      "Completed runtime request retention",
    );
    this.failedRetentionMs = requirePositiveInteger(
      options.failedRetentionMs ?? DEFAULT_FAILED_RUNTIME_REQUEST_RETENTION_MS,
      "Failed runtime request retention",
    );
    this.pruneBatchSize = requirePositiveInteger(
      options.pruneBatchSize ?? DEFAULT_RUNTIME_REQUEST_PRUNE_BATCH_SIZE,
      "Runtime request prune batch size",
    );
    this.now = options.now ?? Date.now;
    this.maxConcurrency = requirePositiveInteger(
      options.maxConcurrency ?? DEFAULT_RUNTIME_REQUEST_CONCURRENCY,
      "Runtime request concurrency",
    );
    this.shutdownDrainTimeoutMs = requirePositiveInteger(
      options.shutdownDrainTimeoutMs ?? DEFAULT_RUNTIME_REQUEST_SHUTDOWN_DRAIN_TIMEOUT_MS,
      "Runtime request shutdown drain timeout",
    );
    this.onError = options.onError;
    this.loop = new DrainLoop({
      label: options.label ?? "runtime request drain",
      drain: () => this.drain(),
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_RUNTIME_REQUEST_DRAIN_POLL_INTERVAL_MS,
      onError: options.onError,
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    this.stopPromise ??= this.stopOnce();
    return this.stopPromise;
  }

  async trigger(): Promise<void> {
    await this.loop.trigger();
  }

  kick(): void {
    this.loop.kick();
  }

  private async drain(): Promise<void> {
    while (!this.loop.isStopped && this.active.size < this.maxConcurrency) {
      const request = await this.requests.claimNextPendingRequest();
      if (!request) {
        await this.pruneIfDue();
        return;
      }
      if (this.loop.isStopped) {
        const claimToken = request.claimToken;
        if (claimToken) {
          await this.requests.releaseRequestClaim(request.id, claimToken);
        }
        return;
      }
      this.startClaimedRequest(request);
    }
  }

  private startClaimedRequest(request: RuntimeRequestRecord): void {
    const controller = new AbortController();
    let task!: Promise<void>;
    task = this.processClaimedRequest(request, controller.signal)
      .catch(async (error) => {
        try {
          await this.onError?.(error);
        } catch (reportError) {
          console.error("Runtime request error reporter failed", {
            error: reportError instanceof Error ? reportError.message : String(reportError),
          });
        }
      })
      .finally(() => {
        this.active.delete(task);
        if (!this.loop.isStopped) {
          this.loop.kick();
        }
      });
    this.active.set(task, controller);
  }

  private async processClaimedRequest(request: RuntimeRequestRecord, signal: AbortSignal): Promise<void> {
    const claimToken = request.claimToken;
    if (!claimToken) {
      throw new Error(`Claimed runtime request ${request.id} is missing its claim token.`);
    }

    let renewalInFlight = Promise.resolve();
    let lostClaim: Error | null = null;
    const renew = () => {
      renewalInFlight = renewalInFlight.then(async () => {
        try {
          if (!await this.requests.renewRequestClaim(request.id, claimToken)) {
            lostClaim ??= new Error(`Runtime request ${request.id} claim was lost while processing.`);
          }
        } catch {
          // A transient renewal failure does not surrender ownership. Settlement
          // remains token-fenced and will reject if another daemon reclaimed it.
        }
      });
    };
    const claimRenewIntervalMs = this.claimRenewIntervalMs
      ?? (request.claimExpiresAt === undefined
        ? DEFAULT_RUNTIME_REQUEST_CLAIM_RENEW_INTERVAL_MS
        : Math.max(1, Math.floor(
          (request.claimExpiresAt - (request.claimedAt ?? request.createdAt)) / 3,
        )));
    const renewalTimer = setInterval(renew, claimRenewIntervalMs);
    const stopRenewing = () => clearInterval(renewalTimer);
    signal.addEventListener("abort", stopRenewing, {once: true});
    if (signal.aborted) stopRenewing();

    let result: unknown;
    let processingError: unknown;
    let processingFailed = false;
    try {
      result = await this.processRequest(request, signal);
    } catch (error) {
      processingFailed = true;
      processingError = error;
    } finally {
      stopRenewing();
      signal.removeEventListener("abort", stopRenewing);
      await renewalInFlight;
    }

    if (lostClaim) {
      throw lostClaim;
    }
    if (signal.aborted || this.loop.isStopped) {
      await this.requests.releaseRequestClaim(request.id, claimToken);
      return;
    }
    if (processingFailed) {
      await this.requests.failRequest(
        request.id,
        claimToken,
        processingError instanceof Error ? processingError.message : String(processingError),
      );
      return;
    }

    await this.requests.completeRequest(request.id, claimToken, result);
  }

  private async stopOnce(): Promise<void> {
    // Cooperative handlers release their claims. A non-cooperative handler
    // stops renewing immediately, so its token-fenced lease can expire and be
    // replayed without holding daemon shutdown forever.
    const loopStopped = this.loop.stop();
    for (const controller of this.active.values()) {
      controller.abort(new Error("Runtime request drain stopped."));
    }

    const settled = Promise.allSettled([loopStopped, ...this.active.keys()]).then(() => true);
    let timer: NodeJS.Timeout | null = null;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.shutdownDrainTimeoutMs);
    });
    const drained = await Promise.race([settled, timedOut]);
    if (timer) clearTimeout(timer);
    if (!drained) {
      console.error("Runtime request drain shutdown timed out", {
        activeRequests: this.active.size,
        timeoutMs: this.shutdownDrainTimeoutMs,
      });
    }
  }

  private async pruneIfDue(): Promise<void> {
    const now = this.now();
    if (now - this.lastPrunedAt < this.pruneIntervalMs) {
      return;
    }

    await this.requests.pruneSettledRequests({
      completedBefore: new Date(now - this.completedRetentionMs),
      failedBefore: new Date(now - this.failedRetentionMs),
      limit: this.pruneBatchSize,
    });
    this.lastPrunedAt = now;
  }
}
