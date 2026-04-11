import {stringToUserMessage} from "../../../kernel/agent/index.js";
import type {HomeThreadStore} from "../../threads/home/store.js";
import type {HomeThreadRecord} from "../../threads/home/types.js";
import type {ThreadRuntimeCoordinator} from "../../threads/runtime/coordinator.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_CLAIM_TTL_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const HEARTBEAT_SOURCE = "heartbeat";
const HEARTBEAT_CLAIM_OWNER = "heartbeat-runner";

function buildHeartbeatPrompt(scheduledFor: number, guidance?: string | null): string {
  const heartbeatGuidance = guidance?.trim();
  return [
    "[Heartbeat]",
    "This is a periodic wake from Panda.",
    "Review pending promises, reminders, and unfinished follow-ups.",
    ...(heartbeatGuidance
      ? ["", "[Heartbeat Guidance]", heartbeatGuidance]
      : []),
    "",
    "Do not invent stale work.",
    "Only use outbound if you intentionally want to reach the user.",
    "If nothing needs attention, keep it quiet and move on.",
    `Scheduled fire time: ${new Date(scheduledFor).toISOString()}`,
  ].join("\n");
}

function computeNextHeartbeatFireAt(home: HomeThreadRecord, now: number): number {
  return now + home.heartbeat.everyMinutes * 60_000;
}

export interface HeartbeatRunnerOptions {
  homeThreads: HomeThreadStore;
  coordinator: ThreadRuntimeCoordinator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  resolveInstructions?: (home: HomeThreadRecord) => Promise<string | null> | string | null;
  onError?: (error: unknown, identityId?: string) => Promise<void> | void;
}

export class HeartbeatRunner {
  private readonly homeThreads: HomeThreadStore;
  private readonly coordinator: ThreadRuntimeCoordinator;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly resolveInstructions?: (home: HomeThreadRecord) => Promise<string | null> | string | null;
  private readonly onError?: (error: unknown, identityId?: string) => Promise<void> | void;

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private drainPromise: Promise<void> | null = null;
  private pendingDrain = false;

  constructor(options: HeartbeatRunnerOptions) {
    this.homeThreads = options.homeThreads;
    this.coordinator = options.coordinator;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.resolveInstructions = options.resolveInstructions;
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
      const dueHeartbeats = await this.homeThreads.listDueHeartbeats({
        limit: DEFAULT_BATCH_SIZE,
      });
      if (dueHeartbeats.length === 0) {
        return;
      }

      let claimedAny = false;
      for (const home of dueHeartbeats) {
        if (this.stopped) {
          return;
        }

        const claimed = await this.homeThreads.claimHeartbeat({
          identityId: home.identityId,
          claimedBy: HEARTBEAT_CLAIM_OWNER,
          claimExpiresAt: Date.now() + this.claimTtlMs,
        });
        if (!claimed) {
          continue;
        }

        claimedAny = true;
        try {
          await this.processHeartbeat(claimed);
        } catch (error) {
          await this.onError?.(error, claimed.identityId);
        }
      }

      if (!claimedAny) {
        return;
      }
    }
  }

  private async processHeartbeat(home: HomeThreadRecord): Promise<void> {
    const now = Date.now();
    // Re-read after claim so a concurrent home reset/switch follows the new home pointer
    // instead of sending one stray heartbeat into the stale thread snapshot we claimed.
    const currentHome = await this.homeThreads.resolveHomeThread({
      identityId: home.identityId,
    });
    if (!currentHome) {
      throw new Error(`Unknown home thread for identity ${home.identityId}`);
    }

    const nextFireAt = computeNextHeartbeatFireAt(currentHome, now);

    if (await this.coordinator.isThreadBusy(currentHome.threadId)) {
      await this.homeThreads.recordHeartbeatResult({
        identityId: home.identityId,
        claimedBy: HEARTBEAT_CLAIM_OWNER,
        nextFireAt,
        lastSkipReason: "busy",
      });
      return;
    }

    try {
      const guidance = await this.resolveInstructions?.(currentHome);
      await this.coordinator.submitInput(currentHome.threadId, {
        message: stringToUserMessage(buildHeartbeatPrompt(currentHome.heartbeat.nextFireAt, guidance)),
        source: HEARTBEAT_SOURCE,
        metadata: {
          heartbeat: {
            kind: "interval",
            scheduledFor: new Date(currentHome.heartbeat.nextFireAt).toISOString(),
            identityId: home.identityId,
          },
        },
      });
      await this.homeThreads.recordHeartbeatResult({
        identityId: home.identityId,
        claimedBy: HEARTBEAT_CLAIM_OWNER,
        nextFireAt,
        lastFireAt: now,
        lastSkipReason: null,
      });
    } catch (error) {
      await this.homeThreads.recordHeartbeatResult({
        identityId: home.identityId,
        claimedBy: HEARTBEAT_CLAIM_OWNER,
        nextFireAt,
        lastSkipReason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
