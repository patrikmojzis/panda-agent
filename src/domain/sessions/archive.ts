import {randomUUID} from "node:crypto";

import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {buildChannelActionTableNames} from "../channels/actions/postgres-shared.js";
import {buildOutboundDeliveryTableNames} from "../channels/deliveries/postgres-shared.js";
import {buildMcpTableNames} from "../mcp/postgres-shared.js";
import {computeRecurringNextFireAt} from "../scheduling/tasks/schedule.js";
import {buildScheduledTaskTableNames} from "../scheduling/tasks/postgres-shared.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import type {ThreadRunOwner} from "../threads/runtime/types.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import {buildWatchTableNames} from "../watches/postgres-shared.js";
import {PostgresSessionStore} from "./postgres.js";
import {buildSessionTableNames} from "./postgres-shared.js";
import type {SessionRecord} from "./types.js";

const ARCHIVE_REASON = "Session archived.";

const liveVoiceTables = buildRuntimeRelationNames({
  sessions: "live_voice_sessions",
  turns: "live_voice_turns",
});
const discordVoiceTables = buildRuntimeRelationNames({controls: "discord_voice_controls"});

export class SessionArchiveConflictError extends Error {
  override readonly name = "SessionArchiveConflictError";
}

export interface SessionArchiveResult {
  session: SessionRecord;
  discardedInputs: number;
  cancelledTaskRuns: number;
  failedWatchRuns: number;
  failedDeliveries: number;
  failedActions: number;
  failedVoiceTurns: number;
}

interface LockedBranchSession {
  currentThreadId: string;
  archived: boolean;
}

function rowCount(result: {rowCount?: number | null}): number {
  return result.rowCount ?? 0;
}

async function lockBranchSession(
  queryable: PgQueryable,
  sessionId: string,
  expectedThreadId: string,
): Promise<LockedBranchSession> {
  const sessions = buildSessionTableNames().sessions;
  const result = await queryable.query(`
    SELECT kind, current_thread_id, archived_at
    FROM ${sessions}
    WHERE id = $1
    FOR UPDATE
  `, [sessionId]);
  const row = result.rows[0] as {
    kind?: unknown;
    current_thread_id?: unknown;
    archived_at?: unknown;
  } | undefined;
  if (!row) throw new Error(`Unknown session ${sessionId}`);
  if (row.kind !== "branch") {
    throw new Error(`Only branch sessions can be archived; session ${sessionId} is ${String(row.kind)}.`);
  }
  if (row.current_thread_id !== expectedThreadId) {
    throw new SessionArchiveConflictError(
      `Session ${sessionId} changed current thread while its archive lifecycle was waiting.`,
    );
  }
  return {currentThreadId: expectedThreadId, archived: row.archived_at !== null};
}

/**
 * Owns the durable archive transition. Callers must first stop the current
 * thread and enter the coordinator's exclusive lane for that thread.
 */
export class PostgresSessionArchive {
  private readonly pool: PgPoolLike;
  private readonly sessions: PostgresSessionStore;
  private readonly threads: PostgresThreadRuntimeStore;

  constructor(options: {
    pool: PgPoolLike;
    sessions: PostgresSessionStore;
    threads: PostgresThreadRuntimeStore;
  }) {
    this.pool = options.pool;
    this.sessions = options.sessions;
    this.threads = options.threads;
  }

  async archive(input: {
    sessionId: string;
    expectedThreadId: string;
    owner: ThreadRunOwner;
  }): Promise<SessionArchiveResult> {
    const sessionTables = buildSessionTableNames();
    const taskTables = buildScheduledTaskTableNames();
    const watchTables = buildWatchTableNames();
    const deliveryTables = buildOutboundDeliveryTableNames();
    const actionTables = buildChannelActionTableNames();
    const mcpTables = buildMcpTableNames();

    const counts = await withTransaction(this.pool, async (client) => {
      // Preserve the daemon lease -> session -> thread lock order used by reset.
      await this.threads.lockOwnerRecord(input.owner, client);
      await lockBranchSession(client, input.sessionId, input.expectedThreadId);
      await this.threads.assertExclusiveAccessAfterOwnerLockRecord(
        input.expectedThreadId,
        input.owner,
        client,
      );

      const discardedInputs = await this.threads.discardPendingInputsRecord(input.expectedThreadId, client);
      await client.query(`
        UPDATE ${sessionTables.sessions}
        SET archived_at = COALESCE(archived_at, NOW()),
            updated_at = NOW()
        WHERE id = $1
      `, [input.sessionId]);
      await client.query(`
        UPDATE ${sessionTables.sessionRuntimeConfig}
        SET pending_wake_at = NULL,
            updated_at = NOW()
        WHERE session_id = $1
      `, [input.sessionId]);
      await client.query(`
        DELETE FROM "runtime"."session_compaction_requests" WHERE session_id = $1
      `, [input.sessionId]);

      const cancelledTaskRuns = await client.query(`
        UPDATE ${taskTables.scheduledTaskRuns}
        SET status = 'cancelled',
            error = COALESCE(error, $2),
            claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            finished_at = NOW()
        WHERE session_id = $1
          AND status IN ('pending', 'claimed', 'running')
      `, [input.sessionId, ARCHIVE_REASON]);
      const failedWatchRuns = await client.query(`
        UPDATE ${watchTables.watchRuns}
        SET status = 'failed',
            error = COALESCE(error, $2),
            finished_at = NOW()
        WHERE session_id = $1
          AND status IN ('claimed', 'running')
      `, [input.sessionId, ARCHIVE_REASON]);
      await client.query(`
        UPDATE ${watchTables.watches}
        SET claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE session_id = $1
      `, [input.sessionId]);
      await client.query(`
        UPDATE ${sessionTables.sessionHeartbeats}
        SET claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE session_id = $1
      `, [input.sessionId]);
      const failedDeliveries = await client.query(`
        UPDATE ${deliveryTables.outboundDeliveries}
        SET status = 'failed',
            last_error = COALESCE(last_error, $2),
            completed_at = NOW(),
            updated_at = NOW()
        WHERE session_id = $1
          AND status = 'pending'
      `, [input.sessionId, ARCHIVE_REASON]);
      const failedActions = await client.query(`
        UPDATE ${actionTables.channelActions}
        SET status = 'failed',
            last_error = COALESCE(last_error, $2),
            completed_at = NOW(),
            updated_at = NOW()
        WHERE session_id = $1
          AND status = 'pending'
      `, [input.sessionId, ARCHIVE_REASON]);
      const failedVoiceTurns = await client.query(`
        UPDATE ${liveVoiceTables.turns}
        SET status = 'failed',
            error = COALESCE(error, 'session_archived'),
            completed_at = NOW(),
            updated_at = NOW()
        WHERE session_id = $1
          AND status IN ('pending', 'queued', 'running', 'awaiting_final', 'final_sending')
      `, [input.sessionId]);
      await client.query(`
        UPDATE ${discordVoiceTables.controls}
        SET status = 'failed',
            error = COALESCE(error, 'session_archived'),
            completed_at = NOW(),
            updated_at = NOW()
        WHERE session_id = $1
          AND status = 'pending'
          AND operation <> 'leave'
      `, [input.sessionId]);
      const activeVoice = await client.query(`
        SELECT id, connector_key, session_id, agent_key, room_key
        FROM ${liveVoiceTables.sessions} AS voice
        WHERE voice.session_id = $1
          AND voice.source = 'discord'
          AND voice.state IN ('connecting', 'connected')
      `, [input.sessionId]);
      for (const rawVoice of activeVoice.rows) {
        const voice = rawVoice as Record<string, unknown>;
        await client.query(`
          INSERT INTO ${discordVoiceTables.controls} (
            id, connector_key, operation, session_id, agent_key, channel_id,
            idempotency_key, status
          ) VALUES ($1, $2, 'leave', $3, $4, $5, $6, 'pending')
          ON CONFLICT (idempotency_key) DO NOTHING
        `, [
          randomUUID(),
          voice.connector_key,
          voice.session_id,
          voice.agent_key,
          voice.room_key,
          `session-archive:${String(voice.session_id)}:${String(voice.id)}`,
        ]);
      }
      await client.query(`
        UPDATE ${mcpTables.oauthAttempts}
        SET expires_at = LEAST(expires_at, NOW())
        WHERE initiated_session_id = $1
          AND consumed_at IS NULL
          AND expires_at > NOW()
      `, [input.sessionId]);

      return {
        discardedInputs,
        cancelledTaskRuns: rowCount(cancelledTaskRuns),
        failedWatchRuns: rowCount(failedWatchRuns),
        failedDeliveries: rowCount(failedDeliveries),
        failedActions: rowCount(failedActions),
        failedVoiceTurns: rowCount(failedVoiceTurns),
      };
    });

    return {session: await this.sessions.getSession(input.sessionId), ...counts};
  }

  async restore(input: {
    sessionId: string;
    expectedThreadId: string;
    owner: ThreadRunOwner;
    restoredAt?: number;
  }): Promise<SessionRecord> {
    const restoredAt = input.restoredAt ?? Date.now();
    const sessionTables = buildSessionTableNames();
    const threadTables = buildThreadRuntimeTableNames();
    const taskTables = buildScheduledTaskTableNames();
    const watchTables = buildWatchTableNames();

    await withTransaction(this.pool, async (client) => {
      await this.threads.lockOwnerRecord(input.owner, client);
      const locked = await lockBranchSession(client, input.sessionId, input.expectedThreadId);
      await this.threads.assertExclusiveAccessAfterOwnerLockRecord(
        input.expectedThreadId,
        input.owner,
        client,
      );
      if (!locked.archived) return;

      const tasks = await client.query(`
        SELECT id, schedule_kind, run_at, cron_expr, timezone
        FROM ${taskTables.scheduledTasks}
        WHERE session_id = $1
          AND enabled = TRUE
          AND completed_at IS NULL
          AND cancelled_at IS NULL
        ORDER BY id
        FOR UPDATE
      `, [input.sessionId]);
      for (const raw of tasks.rows) {
        const task = raw as Record<string, unknown>;
        if (task.schedule_kind === "recurring") {
          if (typeof task.cron_expr !== "string" || typeof task.timezone !== "string") {
            throw new Error(`Recurring task ${String(task.id)} has an invalid schedule.`);
          }
          const nextFireAt = computeRecurringNextFireAt({
            kind: "recurring",
            cron: task.cron_expr,
            timezone: task.timezone,
          }, restoredAt);
          await client.query(`
            UPDATE ${taskTables.scheduledTasks}
            SET next_fire_at = $2,
                updated_at = NOW()
            WHERE id = $1
          `, [task.id, new Date(nextFireAt)]);
          continue;
        }
        const runAt = task.run_at instanceof Date ? task.run_at.getTime() : Date.parse(String(task.run_at));
        if (!Number.isFinite(runAt)) throw new Error(`One-shot task ${String(task.id)} has an invalid run time.`);
        if (runAt <= restoredAt) {
          await client.query(`
            INSERT INTO ${taskTables.scheduledTaskRuns} (
              id, task_id, session_id, scheduled_for, status, error, finished_at
            ) VALUES ($1, $2, $3, $4, 'cancelled', 'Missed while session was archived.', NOW())
            ON CONFLICT (task_id, scheduled_for) DO NOTHING
          `, [randomUUID(), task.id, input.sessionId, new Date(runAt)]);
          await client.query(`
            UPDATE ${taskTables.scheduledTasks}
            SET cancelled_at = COALESCE(cancelled_at, NOW()),
                next_fire_at = NULL,
                updated_at = NOW()
            WHERE id = $1
          `, [task.id]);
        } else {
          await client.query(`
            UPDATE ${taskTables.scheduledTasks}
            SET next_fire_at = $2,
                updated_at = NOW()
            WHERE id = $1
          `, [task.id, new Date(runAt)]);
        }
      }

      await client.query(`
        UPDATE ${watchTables.watches}
        SET next_poll_at = $2::timestamptz + interval_minutes * INTERVAL '1 minute',
            claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE session_id = $1
          AND enabled = TRUE
          AND disabled_at IS NULL
      `, [input.sessionId, new Date(restoredAt)]);
      await client.query(`
        UPDATE ${sessionTables.sessionHeartbeats}
        SET next_fire_at = $2::timestamptz + every_minutes * INTERVAL '1 minute',
            claimed_at = NULL,
            claimed_by = NULL,
            claim_expires_at = NULL,
            updated_at = NOW()
        WHERE session_id = $1
          AND enabled = TRUE
      `, [input.sessionId, new Date(restoredAt)]);
      await client.query(`
        UPDATE ${threadTables.threads}
        SET run_claims_blocked_at = NULL,
            updated_at = NOW()
        WHERE id = $1
      `, [input.expectedThreadId]);
      await client.query(`
        UPDATE ${sessionTables.sessions}
        SET archived_at = NULL,
            updated_at = NOW()
        WHERE id = $1
      `, [input.sessionId]);
    });

    return this.sessions.getSession(input.sessionId);
  }
}
