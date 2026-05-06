import {stringToUserMessage} from "../../kernel/agent/index.js";
import type {JsonObject} from "../../kernel/agent/types.js";
import {runInBackground} from "../../lib/async.js";
import type {SessionStore} from "../sessions/index.js";
import type {ThreadRuntimeCoordinator} from "../threads/runtime/coordinator.js";
import {renderWatchEventPrompt} from "../../prompts/runtime/watch-events.js";
import type {WatchStore} from "./store.js";
import type {ClaimWatchResult, WatchEvaluationResult, WatchRecord, WatchThreadInputMetadata,} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;
const DEFAULT_BATCH_SIZE = 25;
const WATCH_EVENT_SOURCE = "watch_event";

export type WatchEvaluator = (
  watch: WatchRecord,
  context: {
    agentKey: string;
  },
) => Promise<WatchEvaluationResult>;

export interface WatchRunnerOptions {
  watches: WatchStore;
  sessions: SessionStore;
  coordinator: ThreadRuntimeCoordinator;
  evaluateWatch: WatchEvaluator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  onError?: (error: unknown, watchId?: string) => Promise<void> | void;
}

function computeNextPollAt(watch: ClaimWatchResult["watch"], nowMs: number): number {
  return nowMs + watch.intervalMinutes * 60_000;
}

function buildWatchEventMetadata(claim: ClaimWatchResult, eventId: string): WatchThreadInputMetadata {
  return {
    watchEvent: {
      watchId: claim.watch.id,
      title: claim.watch.title,
      eventId,
      eventKind: claim.watch.detector.kind,
      occurredAt: new Date(claim.run.scheduledFor).toISOString(),
    },
  };
}

function buildWatchEventPrompt(options: {
  claim: ClaimWatchResult;
  summary: string;
  eventId: string;
  payload?: JsonObject;
}): string {
  const promptPayload: JsonObject = {
    watchId: options.claim.watch.id,
    eventId: options.eventId,
  };
  if (options.payload) {
    promptPayload.details = options.payload;
  }

  return renderWatchEventPrompt({
    title: options.claim.watch.title,
    eventKind: options.claim.watch.detector.kind,
    summary: options.summary,
    occurredIso: new Date(options.claim.run.scheduledFor).toISOString(),
    payload: promptPayload,
  });
}

export class WatchRunner {
  private readonly watches: WatchStore;
  private readonly sessions: SessionStore;
  private readonly coordinator: ThreadRuntimeCoordinator;
  private readonly evaluateWatchFn: WatchEvaluator;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly onError?: (error: unknown, watchId?: string) => Promise<void> | void;
  private readonly claimOwner = "watch-runner";

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private drainPromise: Promise<void> | null = null;
  private pendingDrain = false;

  constructor(options: WatchRunnerOptions) {
    this.watches = options.watches;
    this.sessions = options.sessions;
    this.coordinator = options.coordinator;
    this.evaluateWatchFn = options.evaluateWatch;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      this.kickDrain();
    }, this.pollIntervalMs);
    this.kickDrain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    if (this.drainPromise) {
      await this.drainPromise;
    }
  }

  async triggerDrain(): Promise<void> {
    if (this.stopped) {
      return;
    }

    if (this.drainPromise) {
      this.pendingDrain = true;
      return;
    }

    this.drainPromise = this.drain();
    try {
      await this.drainPromise;
    } finally {
      this.drainPromise = null;
      if (this.pendingDrain && !this.stopped) {
        this.pendingDrain = false;
        await this.triggerDrain();
      }
    }
  }

  private kickDrain(): void {
    runInBackground(() => this.triggerDrain(), {
      label: "Watch runner drain",
      onError: this.onError ? (error) => this.onError?.(error) : undefined,
    });
  }

  private async drain(): Promise<void> {
    while (!this.stopped) {
      const dueWatches = await this.watches.listDueWatches({
        limit: DEFAULT_BATCH_SIZE,
      });
      if (dueWatches.length === 0) {
        return;
      }

      let claimedAny = false;
      for (const watch of dueWatches) {
        if (this.stopped) {
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
    const session = await this.sessions.getSession(claim.watch.sessionId);
    const resolvedThreadId = session.currentThreadId;
    if (!resolvedThreadId) {
      await this.watches.failWatchRun({
        runId: claim.run.id,
        error: `Watch ${claim.watch.id} has no resolved thread target.`,
      });
      return;
    }

    await this.watches.startWatchRun({
      runId: claim.run.id,
      resolvedThreadId,
    });

    let evaluation;
    try {
      evaluation = await this.evaluateWatchFn(claim.watch, {
        agentKey: session.agentKey,
      });
    } catch (error) {
      await this.watches.failWatchRun({
        runId: claim.run.id,
        resolvedThreadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!evaluation.changed || !evaluation.event) {
      await this.watches.completeWatchRun({
        runId: claim.run.id,
        status: "no_change",
        resolvedThreadId,
        state: evaluation.nextState,
        lastError: null,
      });
      return;
    }

    const event = await this.watches.recordEvent({
      watchId: claim.watch.id,
      sessionId: claim.watch.sessionId,
      createdByIdentityId: claim.watch.createdByIdentityId,
      resolvedThreadId,
      eventKind: evaluation.event.eventKind,
      summary: evaluation.event.summary,
      dedupeKey: evaluation.event.dedupeKey,
      payload: evaluation.event.payload,
    });

    try {
      await this.coordinator.submitInput(resolvedThreadId, {
        message: stringToUserMessage(buildWatchEventPrompt({
          claim,
          eventId: event.event.id,
          summary: event.event.summary,
          payload: event.event.payload,
        })),
        source: WATCH_EVENT_SOURCE,
        externalMessageId: event.event.id,
        identityId: claim.watch.createdByIdentityId ?? session.createdByIdentityId,
        metadata: buildWatchEventMetadata(claim, event.event.id),
      });
    } catch (error) {
      await this.watches.failWatchRun({
        runId: claim.run.id,
        resolvedThreadId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    await this.watches.completeWatchRun({
      runId: claim.run.id,
      status: "changed",
      resolvedThreadId,
      emittedEventId: event.event.id,
      state: evaluation.nextState,
      lastError: null,
    });
  }
}
