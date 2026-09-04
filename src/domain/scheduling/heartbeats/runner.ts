import {randomUUID} from "node:crypto";

import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {renderHeartbeatPrompt} from "../../../prompts/runtime/heartbeat.js";
import {resolveLocalDateTimeInfo} from "../../../lib/dates.js";
import {DrainLoop} from "../../../lib/drain-loop.js";
import {resolveCurrentSessionThread} from "../../sessions/current-thread.js";
import type {SessionStore} from "../../sessions/store.js";
import type {SessionHeartbeatRecord, SessionRecord} from "../../sessions/types.js";
import type {ThreadRuntimeCoordinator} from "../../threads/runtime/coordinator.js";

const DEFAULT_POLL_INTERVAL_MS = 60_000;
const DEFAULT_CLAIM_TTL_MS = 5 * 60_000;
const DEFAULT_BATCH_SIZE = 100;
const HEARTBEAT_SOURCE = "heartbeat";
type HeartbeatRunnerSessionStore = Pick<
  SessionStore,
  "claimHeartbeat" | "getHeartbeat" | "getSession" | "listDueHeartbeats" | "recordHeartbeatResult"
>;

function buildHeartbeatPrompt(heartbeat: SessionHeartbeatRecord, scheduledFor: number, context?: HeartbeatPromptContext): string {
  const localDateTime = resolveLocalDateTimeInfo(new Date(scheduledFor));
  return renderHeartbeatPrompt({
    scheduledIso: new Date(scheduledFor).toISOString(),
    scheduledLocalDateTime: localDateTime.formattedDateTimeWithZone,
    timeZone: localDateTime.timeZone,
    guidance: context?.guidance,
    everyMinutes: heartbeat.everyMinutes,
    lastChangeReason: heartbeat.lastCadenceChangeReason,
    canConfigureCadence: context?.canConfigureCadence ?? false,
  });
}

function describeHeartbeatFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface HeartbeatPromptContext {
  guidance?: string | null;
  canConfigureCadence: boolean;
}

export interface HeartbeatRunnerOptions {
  sessions: HeartbeatRunnerSessionStore;
  coordinator: Pick<ThreadRuntimeCoordinator, "isThreadBusy">;
  pollIntervalMs?: number;
  claimTtlMs?: number;
  resolvePromptContext?: (session: SessionRecord) => Promise<HeartbeatPromptContext> | HeartbeatPromptContext;
  onError?: (error: unknown, sessionId?: string) => Promise<void> | void;
}

export class HeartbeatRunner {
  private readonly sessions: HeartbeatRunnerSessionStore;
  private readonly coordinator: Pick<ThreadRuntimeCoordinator, "isThreadBusy">;
  private readonly claimTtlMs: number;
  private readonly resolvePromptContext?: HeartbeatRunnerOptions["resolvePromptContext"];
  private readonly onError?: (error: unknown, sessionId?: string) => Promise<void> | void;
  private readonly drainLoop: DrainLoop;

  constructor(options: HeartbeatRunnerOptions) {
    this.sessions = options.sessions;
    this.coordinator = options.coordinator;
    this.claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
    this.resolvePromptContext = options.resolvePromptContext;
    this.onError = options.onError;
    this.drainLoop = new DrainLoop({
      label: "Heartbeat runner drain",
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
      const dueHeartbeats = await this.sessions.listDueHeartbeats({
        limit: DEFAULT_BATCH_SIZE,
      });
      if (dueHeartbeats.length === 0) {
        return;
      }

      let claimedAny = false;
      for (const heartbeat of dueHeartbeats) {
        if (this.drainLoop.isStopped) {
          return;
        }

        const claimed = await this.sessions.claimHeartbeat({
          sessionId: heartbeat.sessionId,
          claimedBy: randomUUID(),
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
    const claimedBy = heartbeat.claimedBy;
    if (!claimedBy) throw new Error(`Heartbeat ${heartbeat.sessionId} has no claim token.`);

    let recordedSkip = false;
    try {
      const {session, threadId} = await resolveCurrentSessionThread(this.sessions, heartbeat.sessionId);

      if (await this.coordinator.isThreadBusy(threadId)) {
        recordedSkip = true;
        await this.sessions.recordHeartbeatResult({
          sessionId: session.id,
          claimedBy,
          configRevision: heartbeat.configRevision,
          attemptedAt: now,
          lastSkipReason: "busy",
        });
        return;
      }

      const promptContext = await this.resolvePromptContext?.(session);
      const deliveryTarget = await resolveCurrentSessionThread(this.sessions, heartbeat.sessionId);
      if (await this.coordinator.isThreadBusy(deliveryTarget.threadId)) {
        recordedSkip = true;
        await this.sessions.recordHeartbeatResult({
          sessionId: deliveryTarget.session.id,
          claimedBy,
          configRevision: heartbeat.configRevision,
          attemptedAt: now,
          lastSkipReason: "busy",
        });
        return;
      }

      const currentHeartbeat = await this.sessions.getHeartbeat(heartbeat.sessionId);
      if (
        !currentHeartbeat?.enabled
        || currentHeartbeat.claimedBy !== claimedBy
        || (currentHeartbeat.claimExpiresAt ?? 0) <= Date.now()
      ) {
        return;
      }

      const acceptance = {
        sessionId: deliveryTarget.session.id,
        claimedBy,
        configRevision: heartbeat.configRevision,
        attemptedAt: now,
        lastFireAt: now,
        lastSkipReason: null,
        input: {
          message: stringToUserMessage(buildHeartbeatPrompt(currentHeartbeat, heartbeat.nextFireAt, promptContext)),
          source: HEARTBEAT_SOURCE,
          identityId: deliveryTarget.session.createdByIdentityId,
          metadata: {heartbeat: {kind: "interval", scheduledFor: new Date(heartbeat.nextFireAt).toISOString(),
            sessionId: deliveryTarget.session.id}},
        },
      };
      for (let attempt = 0; ; attempt += 1) {
        try {
          await this.sessions.recordHeartbeatResult(acceptance);
          break;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    } catch (error) {
      if (!recordedSkip) {
        await this.sessions.recordHeartbeatResult({
          sessionId: heartbeat.sessionId,
          claimedBy,
          configRevision: heartbeat.configRevision,
          attemptedAt: now,
          lastSkipReason: describeHeartbeatFailure(error),
        });
      }
      throw error;
    }
  }
}
