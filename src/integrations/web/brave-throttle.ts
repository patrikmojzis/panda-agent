import {sleepWithSignal} from "../../lib/async.js";

const DEFAULT_MAX_WAITERS = 100;
const DEFAULT_RECOVERY_PACE_MS = 100;

export type BraveRateLimitFailureCode = "rate_limited" | "quota_exhausted";

export interface BraveThrottlePermit {
  probe: boolean;
  waitedMs: number;
}

export interface BraveThrottleBlocked {
  allowed: false;
  retryable: boolean;
  retryAfterMs: number;
  failureCode: BraveRateLimitFailureCode;
  waitedMs: number;
}

export type BraveThrottleAcquireResult =
  | {allowed: true; permit: BraveThrottlePermit}
  | BraveThrottleBlocked;

export interface BraveThrottleGateOptions {
  now?: () => number;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  maxWaiters?: number;
  recoveryPaceMs?: number;
}

interface PendingProbe {
  promise: Promise<void>;
  resolve(): void;
}

function createPendingProbe(): PendingProbe {
  let resolve = () => {};
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return {promise, resolve};
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Brave throttle wait was aborted.");
}

/** Coordinates a shared Brave credential cooldown without observing request content. */
export class BraveThrottleGate {
  private readonly now: () => number;
  private readonly wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  private readonly maxWaiters: number;
  private readonly recoveryPaceMs: number;
  private throttled = false;
  private retryable = true;
  private failureCode: BraveRateLimitFailureCode = "rate_limited";
  private notBefore = 0;
  private pendingProbe?: PendingProbe;
  private waiterCount = 0;
  private pacingRemaining = 0;
  private nextPacedReleaseAt = 0;

  constructor(options: BraveThrottleGateOptions = {}) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? sleepWithSignal;
    this.maxWaiters = Math.max(1, Math.trunc(options.maxWaiters ?? DEFAULT_MAX_WAITERS));
    this.recoveryPaceMs = Math.max(0, Math.trunc(options.recoveryPaceMs ?? DEFAULT_RECOVERY_PACE_MS));
  }

  async acquire(input: {
    deadlineMs: number;
    signal?: AbortSignal;
  }): Promise<BraveThrottleAcquireResult> {
    let registeredWaiter = false;
    let waitedMs = 0;
    const registerWaiter = (): boolean => {
      if (registeredWaiter) {
        return true;
      }
      if (this.waiterCount >= this.maxWaiters) {
        return false;
      }
      this.waiterCount += 1;
      registeredWaiter = true;
      return true;
    };
    const blocked = (retryAfterMs: number): BraveThrottleBlocked => ({
      allowed: false,
      retryable: this.retryable,
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs)),
      failureCode: this.failureCode,
      waitedMs,
    });

    try {
      while (true) {
        if (input.signal?.aborted) {
          throw abortError(input.signal);
        }

        const now = this.now();
        const availableMs = Math.max(0, input.deadlineMs - now);
        if (this.throttled) {
          const cooldownMs = Math.max(0, this.notBefore - now);
          if (!this.retryable && cooldownMs > 0) {
            return blocked(cooldownMs);
          }
          if (cooldownMs > availableMs) {
            return blocked(cooldownMs);
          }
          if (cooldownMs > 0) {
            if (!registerWaiter()) {
              return blocked(cooldownMs);
            }
            await this.wait(cooldownMs, input.signal);
            waitedMs += cooldownMs;
            continue;
          }

          if (this.pendingProbe) {
            if (availableMs <= 0 || !registerWaiter()) {
              return blocked(Math.max(0, this.notBefore - now));
            }
            const before = this.now();
            await this.waitForProbe(this.pendingProbe.promise, availableMs, input.signal);
            waitedMs += Math.max(0, this.now() - before);
            continue;
          }

          this.pendingProbe = createPendingProbe();
          return {allowed: true, permit: {probe: true, waitedMs}};
        }

        if (this.pacingRemaining > 0) {
          const releaseAt = Math.max(this.now(), this.nextPacedReleaseAt);
          this.nextPacedReleaseAt = releaseAt + this.recoveryPaceMs;
          this.pacingRemaining -= 1;
          const delayMs = Math.max(0, releaseAt - this.now());
          if (delayMs > availableMs || !registerWaiter()) {
            return blocked(delayMs);
          }
          if (delayMs > 0) {
            await this.wait(delayMs, input.signal);
            waitedMs += delayMs;
          }
        }

        return {allowed: true, permit: {probe: false, waitedMs}};
      }
    } finally {
      if (registeredWaiter) {
        this.waiterCount -= 1;
      }
    }
  }

  reportRateLimit(input: {
    permit: BraveThrottlePermit;
    retryAfterMs: number;
    retryable: boolean;
    failureCode: BraveRateLimitFailureCode;
  }): void {
    const retryAfterMs = Math.max(0, Math.ceil(input.retryAfterMs));
    this.throttled = true;
    this.retryable = input.retryable;
    this.failureCode = input.failureCode;
    this.notBefore = Math.max(this.notBefore, this.now() + retryAfterMs);
    this.pacingRemaining = 0;
    this.nextPacedReleaseAt = 0;
    if (input.permit.probe) {
      this.finishProbe();
    }
  }

  reportNonRateLimited(permit: BraveThrottlePermit): void {
    if (!permit.probe) {
      return;
    }
    this.throttled = false;
    this.retryable = true;
    this.failureCode = "rate_limited";
    this.notBefore = 0;
    this.pacingRemaining = Math.min(this.waiterCount, this.maxWaiters);
    this.nextPacedReleaseAt = this.now() + this.recoveryPaceMs;
    this.finishProbe();
  }

  reportRequestFailure(permit: BraveThrottlePermit): void {
    if (permit.probe) {
      this.finishProbe();
    }
  }

  retryAfterMs(): number {
    return Math.max(0, Math.ceil(this.notBefore - this.now()));
  }

  private finishProbe(): void {
    const pending = this.pendingProbe;
    this.pendingProbe = undefined;
    pending?.resolve();
  }

  private waitForProbe(
    probe: Promise<void>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        error === undefined ? resolve() : reject(error);
      };
      const onAbort = () => finish(signal ? abortError(signal) : new Error("Brave throttle wait was aborted."));
      const timer = setTimeout(() => finish(), Math.max(0, timeoutMs));
      signal?.addEventListener("abort", onAbort, {once: true});
      probe.then(() => finish(), (error) => finish(error));
    });
  }
}
