import {stringToUserMessage} from "../../kernel/agent/index.js";
import type {JsonObject} from "../../kernel/agent/types.js";
import type {CredentialResolver} from "../credentials/index.js";
import type {HomeThreadStore} from "../threads/home/store.js";
import type {ThreadRuntimeCoordinator} from "../threads/runtime/coordinator.js";
import {renderWatchEventPrompt} from "../../prompts/runtime/watch-events.js";
import {evaluateWatch, type WatchEvaluationOptions} from "./evaluator.js";
import type {WatchStore} from "./store.js";
import type {ClaimWatchResult, WatchThreadInputMetadata,} from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_CLAIM_TTL_MS = 10 * 60_000;
const DEFAULT_BATCH_SIZE = 25;
const WATCH_EVENT_SOURCE = "watch_event";

export interface WatchRunnerOptions extends Omit<WatchEvaluationOptions, "sourceResolvers"> {
  watches: WatchStore;
  homeThreads: HomeThreadStore;
  coordinator: ThreadRuntimeCoordinator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  sourceResolvers?: WatchEvaluationOptions["sourceResolvers"];
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

async function resolveTargetThreadId(
  watch: ClaimWatchResult["watch"],
  homeThreads: HomeThreadStore,
): Promise<string | undefined> {
  if (watch.targetKind === "thread") {
    return watch.targetThreadId;
  }

  const home = await homeThreads.resolveHomeThread({
    identityId: watch.identityId,
  });
  return home?.threadId;
}

export class WatchRunner {
  private readonly watches: WatchStore;
  private readonly homeThreads: HomeThreadStore;
  private readonly coordinator: ThreadRuntimeCoordinator;
  private readonly credentialResolver: CredentialResolver;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly fetchImpl?: WatchEvaluationOptions["fetchImpl"];
  private readonly lookupHostname?: WatchEvaluationOptions["lookupHostname"];
  private readonly sourceResolvers?: WatchEvaluationOptions["sourceResolvers"];
  private readonly onError?: (error: unknown, watchId?: string) => Promise<void> | void;
  private readonly claimOwner = "watch-runner";

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private drainPromise: Promise<void> | null = null;
  private pendingDrain = false;

  constructor(options: WatchRunnerOptions) {
    this.watches = options.watches;
    this.homeThreads = options.homeThreads;
    this.coordinator = options.coordinator;
    this.credentialResolver = options.credentialResolver;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.fetchImpl = options.fetchImpl;
    this.lookupHostname = options.lookupHostname;
    this.sourceResolvers = options.sourceResolvers;
    this.onError = options.onError;
  }

  async start(): Promise<void> {
    if (!this.stopped) {
      return;
    }

    this.stopped = false;
    this.timer = setInterval(() => {
      void this.triggerDrain();
    }, this.pollIntervalMs);
    await this.triggerDrain();
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
    const resolvedThreadId = await resolveTargetThreadId(claim.watch, this.homeThreads);
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
      evaluation = await evaluateWatch(claim.watch, {
        credentialResolver: this.credentialResolver,
        fetchImpl: this.fetchImpl,
        lookupHostname: this.lookupHostname,
        sourceResolvers: this.sourceResolvers,
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
      identityId: claim.watch.identityId,
      agentKey: claim.watch.agentKey,
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
