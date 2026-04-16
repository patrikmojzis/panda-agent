import {stringToUserMessage} from "../../../kernel/agent/index.js";
import {renderHeartbeatPrompt} from "../../../prompts/runtime/heartbeat.js";
import type {SessionHeartbeatRecord, SessionRecord, SessionStore} from "../../sessions/index.js";
import type {ThreadRuntimeCoordinator} from "../../threads/runtime/coordinator.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_CLAIM_TTL_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const HEARTBEAT_SOURCE = "heartbeat";
const HEARTBEAT_CLAIM_OWNER = "heartbeat-runner";

function buildHeartbeatPrompt(scheduledFor: number, guidance?: string | null): string {
  return renderHeartbeatPrompt({
    scheduledIso: new Date(scheduledFor).toISOString(),
    guidance,
  });
}

export interface HeartbeatRunnerOptions {
  sessions: SessionStore;
  coordinator: ThreadRuntimeCoordinator;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  resolveInstructions?: (session: SessionRecord) => Promise<string | null> | string | null;
  onError?: (error: unknown, sessionId?: string) => Promise<void> | void;
}

export class HeartbeatRunner {
  private readonly sessions: SessionStore;
  private readonly coordinator: ThreadRuntimeCoordinator;
  private readonly pollIntervalMs: number;
  private readonly claimTtlMs: number;
  private readonly resolveInstructions?: (session: SessionRecord) => Promise<string | null> | string | null;
  private readonly onError?: (error: unknown, sessionId?: string) => Promise<void> | void;

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private drainPromise: Promise<void> | null = null;
  private pendingDrain = false;

  constructor(options: HeartbeatRunnerOptions) {
    this.sessions = options.sessions;
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
      const dueHeartbeats = await this.sessions.listDueHeartbeats({
        limit: DEFAULT_BATCH_SIZE,
      });
      if (dueHeartbeats.length === 0) {
        return;
      }

      let claimedAny = false;
      for (const heartbeat of dueHeartbeats) {
        if (this.stopped) {
          return;
        }

        const claimed = await this.sessions.claimHeartbeat({
          sessionId: heartbeat.sessionId,
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
          await this.onError?.(error, claimed.sessionId);
        }
      }

      if (!claimedAny) {
        return;
      }
    }
  }

  private async processHeartbeat(heartbeat: SessionHeartbeatRecord): Promise<void> {
    const now = Date.now();
    const session = await this.sessions.getSession(heartbeat.sessionId);
    const nextFireAt = now + heartbeat.everyMinutes * 60_000;

    if (await this.coordinator.isThreadBusy(session.currentThreadId)) {
      await this.sessions.recordHeartbeatResult({
        sessionId: session.id,
        claimedBy: HEARTBEAT_CLAIM_OWNER,
        nextFireAt,
        lastSkipReason: "busy",
      });
      return;
    }

    try {
      const guidance = await this.resolveInstructions?.(session);
      await this.coordinator.submitInput(session.currentThreadId, {
        message: stringToUserMessage(buildHeartbeatPrompt(heartbeat.nextFireAt, guidance)),
        source: HEARTBEAT_SOURCE,
        metadata: {
          heartbeat: {
            kind: "interval",
            scheduledFor: new Date(heartbeat.nextFireAt).toISOString(),
            sessionId: session.id,
          },
        },
      });
      await this.sessions.recordHeartbeatResult({
        sessionId: session.id,
        claimedBy: HEARTBEAT_CLAIM_OWNER,
        nextFireAt,
        lastFireAt: now,
        lastSkipReason: null,
      });
    } catch (error) {
      await this.sessions.recordHeartbeatResult({
        sessionId: session.id,
        claimedBy: HEARTBEAT_CLAIM_OWNER,
        nextFireAt,
        lastSkipReason: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}
