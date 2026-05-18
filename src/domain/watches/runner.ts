import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import type {JsonObject} from "../../lib/json.js";
import {DrainLoop} from "../../lib/drain-loop.js";
import {resolveCurrentSessionThread, type CurrentSessionThread} from "../sessions/current-thread.js";
import type {SessionStore} from "../sessions/store.js";
import type {ThreadRuntimeCoordinator} from "../threads/runtime/coordinator.js";
import {renderWatchEventPrompt} from "../../prompts/runtime/watch-events.js";
import type {WatchStore} from "./store.js";
import type {ClaimWatchResult, WatchEvaluationResult, WatchRecord, WatchThreadInputMetadata,} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;
const DEFAULT_BATCH_SIZE = 25;
const WATCH_EVENT_SOURCE = "watch_event";
type WatchCoordinator = Pick<ThreadRuntimeCoordinator, "submitInput">;
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
  coordinator: WatchCoordinator;
  evaluateWatch: WatchEvaluator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  onError?: (error: unknown, watchId?: string) => Promise<void> | void;
}

type WatchRunnerStore = Pick<
  WatchStore,
  | "claimWatch"
  | "completeWatchRun"
  | "failWatchRun"
  | "listDueWatches"
  | "recordEvent"
  | "startWatchRun"
>;

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

function describeWatchFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class WatchRunner {
  private readonly watches: WatchRunnerStore;
  private readonly sessions: WatchSessionStore;
  private readonly coordinator: WatchCoordinator;
  private readonly evaluateWatchFn: WatchEvaluator;
  private readonly claimTtlMs: number;
  private readonly onError?: (error: unknown, watchId?: string) => Promise<void> | void;
  private readonly claimOwner = "watch-runner";
  private readonly drainLoop: DrainLoop;

  constructor(options: WatchRunnerOptions) {
    this.watches = options.watches;
    this.sessions = options.sessions;
    this.coordinator = options.coordinator;
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
    const {session, threadId: resolvedThreadId} = target;

    await this.watches.startWatchRun({
      runId: claim.run.id,
      resolvedThreadId,
    });

    let evaluation;
    try {
      evaluation = await this.evaluateWatchFn(claim.watch, {
        agentKey: session.agentKey,
        identityId: claim.watch.createdByIdentityId ?? session.createdByIdentityId,
      });
    } catch (error) {
      await this.failClaimRun(claim, error, {resolvedThreadId});
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

    const deliveryTarget = await this.resolveClaimTarget(claim, {resolvedThreadId});
    if (!deliveryTarget) {
      return;
    }
    const deliveryThreadId = deliveryTarget.threadId;

    const event = await this.watches.recordEvent({
      watchId: claim.watch.id,
      sessionId: claim.watch.sessionId,
      createdByIdentityId: claim.watch.createdByIdentityId,
      resolvedThreadId: deliveryThreadId,
      eventKind: evaluation.event.eventKind,
      summary: evaluation.event.summary,
      dedupeKey: evaluation.event.dedupeKey,
      payload: evaluation.event.payload,
    });

    try {
      await this.coordinator.submitInput(deliveryThreadId, {
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
      await this.failClaimRun(claim, error, {resolvedThreadId: deliveryThreadId});
      return;
    }

    await this.watches.completeWatchRun({
      runId: claim.run.id,
      status: "changed",
      resolvedThreadId: deliveryThreadId,
      emittedEventId: event.event.id,
      state: evaluation.nextState,
      lastError: null,
    });
  }

  private async resolveClaimTarget(
    claim: ClaimWatchResult,
    details: {
      resolvedThreadId?: string;
    } = {},
  ): Promise<CurrentSessionThread | null> {
    try {
      return await resolveCurrentSessionThread(this.sessions, claim.watch.sessionId);
    } catch (error) {
      await this.failClaimRun(claim, error, details);
      return null;
    }
  }

  private async failClaimRun(
    claim: ClaimWatchResult,
    error: unknown,
    details: {
      resolvedThreadId?: string;
    } = {},
  ): Promise<void> {
    await this.watches.failWatchRun({
      runId: claim.run.id,
      error: describeWatchFailure(error),
      ...(details.resolvedThreadId ? {resolvedThreadId: details.resolvedThreadId} : {}),
    });
  }
}
