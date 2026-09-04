import {randomUUID} from "node:crypto";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {renderSessionCompactionOutcome} from "../../prompts/runtime/compaction.js";
import {buildActiveThreadRunGuardCte} from "../threads/runtime/postgres-run-claims.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import {parseMessageRow} from "../threads/runtime/postgres-rows.js";
import {buildThreadRuntimeNotificationChannel} from "../threads/runtime/postgres-notifications.js";
import {ThreadRunClaimLostError} from "../threads/runtime/store.js";
import type {SessionCompactionOutcome, SessionCompactionRequest, SessionCompactionStore} from "./compaction.js";

function parseRequest(row: Record<string, unknown>): SessionCompactionRequest {
  if (typeof row.instructions !== "string") throw new Error("Invalid compaction instructions.");
  return {
    id: requireNonEmptyString(row.id, "Compaction request id is required."),
    outcomeId: requireNonEmptyString(row.outcome_id, "Compaction outcome id is required."),
    sessionId: requireNonEmptyString(row.session_id, "Compaction session id is required."),
    instructions: row.instructions,
  };
}

/** Shares the runtime pool and fences request admission and settlement with the active run. */
export class PostgresSessionCompactionStore implements SessionCompactionStore {
  constructor(private readonly pool: PgQueryable) {}

  private activeSessionCte(): string {
    return `${buildActiveThreadRunGuardCte(buildThreadRuntimeTableNames(), {runIdParameter: 2})},
      active_session AS (
        SELECT session.id, active_run.thread_id
        FROM active_run
        JOIN "runtime"."threads" AS thread ON thread.id = active_run.thread_id
        JOIN "runtime"."agent_sessions" AS session
          ON session.id = thread.session_id AND session.current_thread_id = thread.id
        WHERE session.id = $1 AND session.archived_at IS NULL
          AND thread.run_claims_blocked_at IS NULL AND active_run.abort_requested_at IS NULL
      )`;
  }

  async request(sessionId: string, runId: string, instructions: string): Promise<SessionCompactionRequest> {
    const result = await this.pool.query(`
      WITH ${this.activeSessionCte()}, requested AS (
        INSERT INTO "runtime"."session_compaction_requests" AS request (session_id, id, instructions, outcome_id)
        SELECT active_session.id, $3::uuid, $4, $5::uuid FROM active_session
        ON CONFLICT (session_id) DO UPDATE SET instructions = request.instructions
        RETURNING *
      ), woken AS (
        INSERT INTO "runtime"."session_runtime_config" (session_id, pending_wake_at, pending_wake_generation)
        SELECT session_id, NOW(), 1 FROM requested
        ON CONFLICT (session_id) DO UPDATE SET pending_wake_at = NOW(),
          pending_wake_generation = "runtime"."session_runtime_config".pending_wake_generation + 1
        RETURNING session_id
      )
      SELECT requested.* FROM requested JOIN woken USING (session_id)
    `, [sessionId, runId, randomUUID(), instructions, randomUUID()]);
    if (!result.rows[0]) throw new ThreadRunClaimLostError(runId);
    return parseRequest(result.rows[0] as Record<string, unknown>);
  }

  async read(sessionId: string): Promise<SessionCompactionRequest | null> {
    const result = await this.pool.query(
      'SELECT * FROM "runtime"."session_compaction_requests" WHERE session_id = $1', [sessionId],
    );
    return result.rows[0] ? parseRequest(result.rows[0] as Record<string, unknown>) : null;
  }

  async complete(request: SessionCompactionRequest, runId: string, outcome: SessionCompactionOutcome) {
    try {
      return await this.commitOutcome(request, runId, outcome);
    } catch (error) {
      // Settlement deletes the pending request and appends its outcome atomically.
      // A lost response must not fail a run whose outcome was already committed.
      const receipt = await this.pool.query(`
        SELECT message.* FROM "runtime"."messages" AS message
        JOIN "runtime"."threads" AS thread ON thread.id = message.thread_id
        WHERE message.id = $1::uuid AND thread.session_id = $2
          AND message.metadata->>'requestId' = $3
          AND message.metadata->>'kind' = 'session_compaction_outcome'
      `, [request.outcomeId, request.sessionId, request.id]);
      if (!receipt.rows[0]) throw error;
      return parseMessageRow(receipt.rows[0] as Record<string, unknown>);
    }
  }

  private async commitOutcome(request: SessionCompactionRequest, runId: string, outcome: SessionCompactionOutcome) {
    const result = await this.pool.query(`
      WITH ${this.activeSessionCte()}, settled AS (
        DELETE FROM "runtime"."session_compaction_requests" AS request
        USING active_session
        WHERE request.session_id = active_session.id AND request.id = $3::uuid
        RETURNING request.id, active_session.thread_id
      ), inserted AS (
        INSERT INTO "runtime"."messages" (id, thread_id, origin, source, run_id, run_thread_id, metadata, message, created_at)
        SELECT $4::uuid, thread_id, 'runtime', 'runtime', $2::uuid, thread_id, $5::jsonb, $6::jsonb, NOW()
        FROM settled RETURNING *
      ), touched AS (
        UPDATE "runtime"."threads" AS thread SET updated_at = NOW()
        FROM inserted WHERE thread.id = inserted.thread_id RETURNING thread.id
      ), notified AS (
        SELECT pg_notify($7, json_build_object('kind', 'thread_changed', 'threadId', id)::text) FROM touched
      )
      SELECT (SELECT count(*) FROM active_session) AS active_count,
             inserted.*,
             (SELECT count(*) FROM notified) AS notification_count
      FROM (VALUES (1)) AS singleton(value) LEFT JOIN inserted ON TRUE
    `, [request.sessionId, runId, request.id, request.outcomeId,
      JSON.stringify({kind: "session_compaction_outcome", requestId: request.id, ...outcome}),
      JSON.stringify(stringToUserMessage(renderSessionCompactionOutcome(outcome))),
      buildThreadRuntimeNotificationChannel(),
    ]);
    const row = result.rows[0] as Record<string, unknown>;
    if (Number(row.active_count) === 0) throw new ThreadRunClaimLostError(runId);
    return row.id ? parseMessageRow(row) : null;
  }
}
