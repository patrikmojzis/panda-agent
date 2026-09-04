import {DrainLoop} from "../../lib/drain-loop.js";
import {resolveCurrentSessionThread, type CurrentSessionThread} from "../sessions/current-thread.js";
import type {SessionStore} from "../sessions/store.js";
import type {WatchStore} from "./store.js";
import type {ClaimWatchResult, WatchEvaluationResult, WatchRecord,} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;
const DEFAULT_BATCH_SIZE = 25;
type WatchSessionStore = Pick<SessionStore, "getSession">;

export type WatchEvaluator = (
  watch: WatchRecord,
  context: {
    agentKey: string;
    identityId?: string;
  },
) => Promise<WatchEvaluationResult>;

export interface WatchRunnerOptions {
  watches: WatchRunnerStore;
  sessions: WatchSessionStore;
  evaluateWatch: WatchEvaluator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  onError?: (error: unknown, watchId?: string) => Promise<void> | void;
}

type WatchRunnerStore = Pick<
  WatchStore,
  | "claimWatch"
  | "acceptWatchEvaluation"
  | "renewWatchClaim"
  | "failWatchRun"
  | "listDueWatches"
  | "startWatchRun"
>;

function computeNextPollAt(watch: ClaimWatchResult["watch"], nowMs: number): number {
  return nowMs + watch.intervalMinutes * 60_000;
}

function describeWatchFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WatchRunner {
  private readonly watches: WatchRunnerStore;
  private readonly sessions: WatchSessionStore;
  private readonly evaluateWatchFn: WatchEvaluator;
  private readonly claimTtlMs: number;
  private readonly onError?: (error: unknown, watchId?: string) => Promise<void> | void;
  private readonly claimOwner = "watch-runner";
  private readonly drainLoop: DrainLoop;

  constructor(options: WatchRunnerOptions) {
    this.watches = options.watches;
    this.sessions = options.sessions;
    this.evaluateWatchFn = options.evaluateWatch;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.onError = options.onError;
    this.drainLoop = new DrainLoop({
      label: "Watch runner drain",
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      drain: () => this.drain(),
      onError: this.onError ? (error) => this.onError?.(error) : undefined,
    });
  }

  async start(): Promise<void> {
    this.drainLoop.start();
  }

  async stop(): Promise<void> {
    await this.drainLoop.stop();
  }

  async triggerDrain(): Promise<void> {
    await this.drainLoop.trigger();
  }

  private async drain(): Promise<void> {
    while (!this.drainLoop.isStopped) {
      const dueWatches = await this.watches.listDueWatches({
        limit: DEFAULT_BATCH_SIZE,
      });
      if (dueWatches.length === 0) {
        return;
      }

      let claimedAny = false;
      for (const watch of dueWatches) {
        if (this.drainLoop.isStopped) {
          return;
        }

        const claim = await this.watches.claimWatch({
          watchId: watch.id,
          claimedBy: this.claimOwner,
          claimExpiresAt: Date.now() + this.claimTtlMs,
          nextPollAt: computeNextPollAt(watch, Date.now()),
        });
        if (!claim) {
          continue;
        }

        claimedAny = true;
        try {
          await this.processClaim(claim);
        } catch (error) {
          await this.onError?.(error, claim.watch.id);
        }
      }

      if (!claimedAny) {
        return;
      }
    }
  }

  private async processClaim(claim: ClaimWatchResult): Promise<void> {
    const target = await this.resolveClaimTarget(claim);
    if (!target) {
      return;
    }
    const {session} = target;

    const started = await this.watches.startWatchRun({runId: claim.run.id});
    if (!started) return;

    let owned = true;
    let renewal = Promise.resolve();
    let renewing = false;
    const timer = setInterval(() => {
      if (renewing || !owned) return;
      renewing = true;
      renewal = Promise.resolve().then(async () => {
        if (!owned) return;
        owned = await this.watches.renewWatchClaim({runId: claim.run.id, claimTtlMs: this.claimTtlMs});
      }).catch(async (error) => {
        owned = false;
        await this.onError?.(error, claim.watch.id);
      }).finally(() => { renewing = false; });
    }, Math.max(1, Math.floor(this.claimTtlMs / 3)));
    let evaluation: WatchEvaluationResult;
    try {
      evaluation = await this.evaluateWatchFn(claim.watch, {
        agentKey: session.agentKey,
        identityId: claim.watch.createdByIdentityId ?? session.createdByIdentityId,
      });
    } catch (error) {
      clearInterval(timer);
      await renewal;
      if (owned) await this.failClaimRun(claim, error);
      return;
    } finally {
      clearInterval(timer);
    }
    await renewal;
    if (!owned) return;
    // Retrying acceptance reads the committed run receipt; it never reevaluates or invents a new occurrence.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.watches.acceptWatchEvaluation({runId: claim.run.id, evaluation});
        return;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
  }

  private async resolveClaimTarget(claim: ClaimWatchResult): Promise<CurrentSessionThread | null> {
    try {
      return await resolveCurrentSessionThread(this.sessions, claim.watch.sessionId);
    } catch (error) {
      await this.failClaimRun(claim, error);
      return null;
    }
  }

  private async failClaimRun(claim: ClaimWatchResult, error: unknown): Promise<void> {
    await this.watches.failWatchRun({runId: claim.run.id, error: describeWatchFailure(error)});
  }
}
