import type {RuntimeRequestRecord} from "../../domain/threads/requests/types.js";
import {RetryableRuntimeRequestError} from "../../domain/threads/requests/errors.js";
import {DrainLoop} from "../../lib/drain-loop.js";

export const DEFAULT_RUNTIME_REQUEST_DRAIN_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_RUNTIME_REQUEST_CONCURRENCY = 4;
export const DEFAULT_RUNTIME_REQUEST_CLAIM_RENEW_INTERVAL_MS = 60_000;
export const DEFAULT_RUNTIME_REQUEST_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;
export const DEFAULT_COMPLETED_RUNTIME_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const DEFAULT_FAILED_RUNTIME_REQUEST_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const DEFAULT_RUNTIME_REQUEST_PRUNE_INTERVAL_MS = 60 * 60_000;
export const DEFAULT_RUNTIME_REQUEST_PRUNE_CATCH_UP_INTERVAL_MS = 5_000;
export const DEFAULT_RUNTIME_REQUEST_PRUNE_BATCH_SIZE = 500;
export const DEFAULT_RUNTIME_REQUEST_PRUNE_MAX_BATCHES = 10;

export interface RuntimeRequestDrainStore {
  claimNextPendingRequest(): Promise<RuntimeRequestRecord | null>;
  renewRequestClaim(id: string, claimToken: string): Promise<boolean>;
  deferRequestClaim(id: string, claimToken: string, error: string, retryAfterMs: number): Promise<boolean>;
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
  afterSettle?(request: RuntimeRequestRecord, status: "completed" | "failed"): Promise<void> | void;
  label?: string;
  onError?: (error: unknown) => Promise<void> | void;
  pollIntervalMs?: number;
  claimRenewIntervalMs?: number;
  pruneIntervalMs?: number;
  pruneCatchUpIntervalMs?: number;
  completedRetentionMs?: number;
  failedRetentionMs?: number;
  pruneBatchSize?: number;
  now?: () => number;
  monotonicNow?: () => number;
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
  private readonly afterSettle?: RuntimeRequestDrainOptions["afterSettle"];
  private readonly loop: DrainLoop;
  private readonly claimRenewIntervalMs?: number;
  private readonly pruneIntervalMs: number;
  private readonly pruneCatchUpIntervalMs: number;
  private readonly completedRetentionMs: number;
  private readonly failedRetentionMs: number;
  private readonly pruneBatchSize: number;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly maxConcurrency: number;
  private readonly shutdownDrainTimeoutMs: number;
  private readonly onError?: (error: unknown) => Promise<void> | void;
  private readonly active = new Map<Promise<void>, AbortController>();
  private nextPruneAt = Number.NEGATIVE_INFINITY;
  private stopPromise: Promise<void> | null = null;

  constructor(options: RuntimeRequestDrainOptions) {
    this.requests = options.requests;
    this.processRequest = options.processRequest;
    this.afterSettle = options.afterSettle;
    this.claimRenewIntervalMs = options.claimRenewIntervalMs === undefined
      ? undefined
      : requirePositiveInteger(options.claimRenewIntervalMs, "Runtime request claim renewal interval");
    this.pruneIntervalMs = requirePositiveInteger(
      options.pruneIntervalMs ?? DEFAULT_RUNTIME_REQUEST_PRUNE_INTERVAL_MS,
      "Runtime request prune interval",
    );
    this.pruneCatchUpIntervalMs = requirePositiveInteger(
      options.pruneCatchUpIntervalMs ?? DEFAULT_RUNTIME_REQUEST_PRUNE_CATCH_UP_INTERVAL_MS,
      "Runtime request prune catch-up interval",
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
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
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
    await this.pruneIfDue();
    while (!this.loop.isStopped && this.active.size < this.maxConcurrency) {
      const claimStartedAt = this.monotonicNow();
      const request = await this.requests.claimNextPendingRequest();
      if (!request) {
        return;
      }
      if (this.loop.isStopped) {
        const claimToken = request.claimToken;
        if (claimToken) {
          await this.requests.releaseRequestClaim(request.id, claimToken);
        }
        return;
      }
      this.startClaimedRequest(request, claimStartedAt);
    }
  }

  private startClaimedRequest(request: RuntimeRequestRecord, claimStartedAt: number): void {
    const controller = new AbortController();
    let task!: Promise<void>;
    task = this.processClaimedRequest(request, controller, claimStartedAt)
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

  private async processClaimedRequest(
    request: RuntimeRequestRecord,
    controller: AbortController,
    claimStartedAt: number,
  ): Promise<void> {
    const signal = controller.signal;
    const claimToken = request.claimToken;
    if (!claimToken) {
      throw new Error(`Claimed runtime request ${request.id} is missing its claim token.`);
    }

    let renewalInFlight = Promise.resolve();
    let lostClaim: Error | null = null;
    const claimTtlMs = request.claimedAt === undefined || request.claimExpiresAt === undefined
      ? undefined
      : request.claimExpiresAt - request.claimedAt;
    let ownershipDeadline = claimTtlMs !== undefined && claimTtlMs > 0
      ? claimStartedAt + claimTtlMs
      : Number.POSITIVE_INFINITY;
    let ownershipTimer: NodeJS.Timeout | null = null;
    const stopOwnershipTimer = () => {
      if (ownershipTimer) clearTimeout(ownershipTimer);
      ownershipTimer = null;
    };
    const loseClaim = (error: Error) => {
      if (lostClaim) return;
      lostClaim = error;
      stopOwnershipTimer();
      controller.abort(error);
    };
    const armOwnershipTimer = () => {
      stopOwnershipTimer();
      if (!Number.isFinite(ownershipDeadline)) return;
      const remainingMs = Math.max(0, ownershipDeadline - this.monotonicNow());
      ownershipTimer = setTimeout(() => {
        loseClaim(new Error(`Runtime request ${request.id} claim expired while processing.`));
      }, remainingMs);
      ownershipTimer.unref?.();
    };
    armOwnershipTimer();
    const renew = () => {
      renewalInFlight = renewalInFlight.then(async () => {
        const renewalStartedAt = this.monotonicNow();
        try {
          if (!await this.requests.renewRequestClaim(request.id, claimToken)) {
            loseClaim(new Error(`Runtime request ${request.id} claim was lost while processing.`));
            return;
          }
          if (claimTtlMs !== undefined && claimTtlMs > 0) {
            ownershipDeadline = renewalStartedAt + claimTtlMs;
            armOwnershipTimer();
          }
        } catch {
          // Transient failures are tolerated only until the last DB-confirmed
          // lease deadline. The local monotonic timer then cancels side effects.
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
    renewalTimer.unref?.();
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
      stopOwnershipTimer();
      signal.removeEventListener("abort", stopRenewing);
      await renewalInFlight;
      stopOwnershipTimer();
    }

    if (lostClaim) {
      throw lostClaim;
    }
    if (signal.aborted || this.loop.isStopped) {
      await this.requests.releaseRequestClaim(request.id, claimToken);
      return;
    }
    if (processingFailed) {
      if (processingError instanceof RetryableRuntimeRequestError) {
        const deferred = await this.requests.deferRequestClaim(
          request.id,
          claimToken,
          processingError.message,
          processingError.retryAfterMs,
        );
        if (!deferred) {
          throw new Error(`Runtime request ${request.id} claim was lost before retry deferral.`);
        }
        // The shortened durable lease is the retry clock. A local kick keeps
        // healthy daemons responsive; lease expiry still works after a crash.
        const retryTimer = setTimeout(() => this.loop.kick(), processingError.retryAfterMs);
        retryTimer.unref?.();
        await this.onError?.(processingError);
        return;
      }
      await this.requests.failRequest(
        request.id,
        claimToken,
        processingError instanceof Error ? processingError.message : String(processingError),
      );
      await this.runAfterSettle(request, "failed");
      return;
    }

    await this.requests.completeRequest(request.id, claimToken, result);
    await this.runAfterSettle(request, "completed");
  }

  private async runAfterSettle(
    request: RuntimeRequestRecord,
    status: "completed" | "failed",
  ): Promise<void> {
    if (!this.afterSettle) return;
    try {
      // Filesystem cleanup is deliberately after the token-fenced database
      // settlement. A crash can leave an orphan receipt for retention to
      // reconcile, but can never leave a replayable request without its byte.
      await this.afterSettle(request, status);
    } catch (error) {
      await this.onError?.(error);
    }
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
    if (now < this.nextPruneAt) {
      return;
    }

    for (let batch = 0; batch < DEFAULT_RUNTIME_REQUEST_PRUNE_MAX_BATCHES; batch += 1) {
      const pruned = await this.requests.pruneSettledRequests({
        completedBefore: new Date(now - this.completedRetentionMs),
        failedBefore: new Date(now - this.failedRetentionMs),
        limit: this.pruneBatchSize,
      });
      if (pruned < this.pruneBatchSize) {
        this.nextPruneAt = now + this.pruneIntervalMs;
        return;
      }
    }
    // Catch up large backlogs in bounded passes without turning every request
    // completion into another burst of retention DELETEs.
    this.nextPruneAt = now + this.pruneCatchUpIntervalMs;
  }
}
