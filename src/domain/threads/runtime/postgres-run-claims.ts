import {randomUUID} from "node:crypto";

import {POSTGRES_CONNECTOR_LEASE_TABLE} from "../../connector-leases/postgres-schema.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import type {SessionTableNames} from "../../sessions/postgres-shared.js";
import {parseRunRow} from "./postgres-rows.js";
import type {ThreadRuntimeTableNames} from "./postgres-shared.js";
import type {ThreadRunOwner, ThreadRunRecord} from "./types.js";
import {ThreadRunClaimLostError} from "./store.js";

/**
 * Builds the SQL fence used by every mutation owned by an active run. The
 * shared lease lock is acquired before the run lock: same-daemon mutations can
 * proceed concurrently, while renewal or takeover cannot split the mutation.
 */
export function buildActiveThreadRunGuardCte(
  tables: ThreadRuntimeTableNames,
  input: {runIdParameter: number; threadIdParameter?: number},
): string {
  const threadPredicate = input.threadIdParameter === undefined
    ? ""
    : `AND run.thread_id = $${input.threadIdParameter}`;
  return `active_run_owner AS MATERIALIZED (
    SELECT
      owner_lease.source,
      owner_lease.connector_key,
      owner_lease.holder_id
    FROM ${tables.runs} AS run
    INNER JOIN ${POSTGRES_CONNECTOR_LEASE_TABLE} AS owner_lease
      ON owner_lease.source = run.owner_source
     AND owner_lease.connector_key = run.owner_key
     AND owner_lease.holder_id = run.owner_holder_id
     AND owner_lease.leased_until > NOW()
    WHERE run.id = $${input.runIdParameter}
      AND run.status = 'running'
      ${threadPredicate}
    FOR SHARE OF owner_lease
  ), active_run AS (
    SELECT
      run.id,
      run.thread_id,
      run.owner_source,
      run.owner_key,
      run.owner_holder_id,
      run.abort_requested_at
    FROM ${tables.runs} AS run
    INNER JOIN active_run_owner AS owner_lease
      ON owner_lease.source = run.owner_source
     AND owner_lease.connector_key = run.owner_key
     AND owner_lease.holder_id = run.owner_holder_id
    WHERE run.id = $${input.runIdParameter}
      AND run.status = 'running'
      ${threadPredicate}
    FOR UPDATE OF run
  )`;
}

/**
 * Fences a background job without requiring its originating run to remain
 * active. Every job snapshots the daemon owner at reservation time, including
 * standalone command jobs, so there is no unfenced run-null escape hatch.
 */
export function buildOwnedToolJobGuardCte(
  tables: ThreadRuntimeTableNames,
  input: {jobIdParameter: number; name?: string},
): string {
  const name = input.name ?? "owned_job";
  const ownerName = `${name}_owner`;
  return `${ownerName} AS MATERIALIZED (
    SELECT
      owner_lease.source,
      owner_lease.connector_key,
      owner_lease.holder_id
    FROM ${tables.toolJobs} AS job
    INNER JOIN ${POSTGRES_CONNECTOR_LEASE_TABLE} AS owner_lease
      ON owner_lease.source = job.owner_source
     AND owner_lease.connector_key = job.owner_key
     AND owner_lease.holder_id = job.owner_holder_id
     AND owner_lease.leased_until > NOW()
    WHERE job.id = $${input.jobIdParameter}
    FOR SHARE OF owner_lease
  ), ${name} AS (
    SELECT job.id, job.thread_id, job.run_id
    FROM ${tables.toolJobs} AS job
    INNER JOIN ${ownerName} AS owner_lease
      ON owner_lease.source = job.owner_source
     AND owner_lease.connector_key = job.owner_key
     AND owner_lease.holder_id = job.owner_holder_id
    WHERE job.id = $${input.jobIdParameter}
      AND job.status = 'running'
    FOR UPDATE OF job
  )`;
}

export async function lockThreadRunOwner(input: {
  queryable: PgQueryable;
  owner: ThreadRunOwner;
}): Promise<void> {
  const result = await input.queryable.query(`
    SELECT 1
    FROM ${POSTGRES_CONNECTOR_LEASE_TABLE}
    WHERE source = $1
      AND connector_key = $2
      AND holder_id = $3
      AND leased_until > NOW()
    FOR SHARE
  `, [input.owner.source, input.owner.connectorKey, input.owner.holderId]);
  if (result.rows.length === 0) {
    throw new Error("Thread runtime daemon owner is no longer current.");
  }
}

export async function tryStartThreadRun(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTables: SessionTableNames;
  threadId: string;
  owner: ThreadRunOwner;
  notificationChannel: string;
}): Promise<ThreadRunRecord | null> {
  const result = await input.queryable.query(`
    WITH current_owner AS MATERIALIZED (
      SELECT source, connector_key, holder_id
      FROM ${POSTGRES_CONNECTOR_LEASE_TABLE}
      WHERE source = $3
        AND connector_key = $4
        AND holder_id = $5
        AND leased_until > NOW()
      -- Claims on unrelated threads share the daemon fence. Lease renewal or
      -- takeover must wait until each claim transaction has either committed
      -- its run or proved that no run can be claimed.
      FOR SHARE
    ), target_session AS MATERIALIZED (
      SELECT thread.session_id
      FROM ${input.tables.threads} AS thread
      CROSS JOIN current_owner
      WHERE thread.id = $2
    ), current_session AS MATERIALIZED (
      SELECT session.id, session.current_thread_id
      FROM ${input.sessionTables.sessions} AS session
      INNER JOIN target_session
        ON target_session.session_id = session.id
      WHERE session.current_thread_id = $2
      -- Reset locks the session before the old thread. Locking and
      -- rechecking this predicate prevents a claim that read the old current
      -- id from waking after reset and starting work on the retired thread.
      -- Resolve the session through the thread primary key first; scanning all
      -- current_thread_id values would turn every claim into table-wide work.
      FOR SHARE OF session
    ), observed_wake AS MATERIALIZED (
      SELECT config.session_id, config.pending_wake_generation
      FROM ${input.sessionTables.sessionRuntimeConfig} AS config
      INNER JOIN current_session AS session ON session.id = config.session_id
      WHERE config.pending_wake_at IS NOT NULL
    ), claimable_thread AS (
      SELECT thread.id
      FROM ${input.tables.threads} AS thread
      INNER JOIN current_session AS session
        ON session.id = thread.session_id
       AND session.current_thread_id = thread.id
      WHERE thread.id = $2
        AND (
          EXISTS (SELECT 1 FROM observed_wake)
          OR EXISTS (
            SELECT 1
            FROM ${input.tables.inputs} AS pending_input
            WHERE pending_input.thread_id = thread.id
              AND pending_input.applied_at IS NULL
              AND pending_input.discarded_at IS NULL
              AND pending_input.delivery_mode = 'wake'
          )
        )
      FOR UPDATE OF thread
    ), inserted_run AS (
      INSERT INTO ${input.tables.runs} (
        id,
        thread_id,
        owner_source,
        owner_key,
        owner_holder_id,
        status,
        started_at
      )
      SELECT $1, claimable_thread.id, $3, $4, $5, 'running', NOW()
      FROM claimable_thread
      ON CONFLICT (thread_id) WHERE status = 'running' DO NOTHING
      RETURNING *
    ), admitted_inputs AS (
      UPDATE ${input.tables.inputs} AS pending_input
      SET delivery_mode = 'queue',
          admitted_run_id = inserted_run.id
      FROM inserted_run
      WHERE pending_input.thread_id = inserted_run.thread_id
        AND pending_input.applied_at IS NULL
        AND pending_input.discarded_at IS NULL
        -- Claim snapshots every pending input visible at this admission edge.
      -- Later queue-only input stays outside the run until a future wake.
      RETURNING pending_input.id
    ), admission_mutation AS MATERIALIZED (
      SELECT COUNT(*) AS admitted_count FROM admitted_inputs
    ), consumed_wake AS (
      -- Clear only the generation visible to this statement. PostgreSQL may
      -- recheck the row after a lock wait without refreshing the statement
      -- snapshot; a newer generation must remain armed for the next boundary.
      UPDATE ${input.sessionTables.sessionRuntimeConfig} AS config
      SET pending_wake_at = NULL,
          updated_at = NOW()
      FROM observed_wake
      CROSS JOIN inserted_run
      CROSS JOIN admission_mutation
      WHERE config.session_id = observed_wake.session_id
        AND config.pending_wake_generation = observed_wake.pending_wake_generation
      RETURNING config.session_id
    ), updated_thread AS (
      UPDATE ${input.tables.threads} AS thread
      SET updated_at = NOW()
      FROM inserted_run
      WHERE thread.id = inserted_run.thread_id
      RETURNING thread.id
    ), notified AS (
      SELECT pg_notify(
        $6,
        json_build_object('kind', 'thread_changed', 'threadId', updated_thread.id)::text
      ) AS notification
      FROM updated_thread
    )
    SELECT inserted_run.*, notified.notification,
           (SELECT COUNT(*) FROM consumed_wake) AS consumed_wake_count,
           (SELECT COUNT(*) FROM admitted_inputs) AS admitted_input_count
    FROM inserted_run
    INNER JOIN notified ON TRUE
  `, [
    randomUUID(),
    input.threadId,
    input.owner.source,
    input.owner.connectorKey,
    input.owner.holderId,
    input.notificationChannel,
  ]);

  const row = result.rows[0] as Record<string, unknown> | undefined;
  return row ? parseRunRow(row) : null;
}

export async function isThreadRunActive(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  runId: string;
}): Promise<boolean> {
  const result = await input.queryable.query(`
    SELECT 1
    FROM ${input.tables.runs} AS run
    INNER JOIN ${POSTGRES_CONNECTOR_LEASE_TABLE} AS owner_lease
      ON owner_lease.source = run.owner_source
     AND owner_lease.connector_key = run.owner_key
     AND owner_lease.holder_id = run.owner_holder_id
     AND owner_lease.leased_until > NOW()
    WHERE run.id = $1
      AND run.status = 'running'
    LIMIT 1
  `, [input.runId]);
  return result.rows.length > 0;
}

export async function completeOwnedThreadRun(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  runId: string;
}): Promise<ThreadRunRecord> {
  const result = await input.queryable.query(`
    WITH ${buildActiveThreadRunGuardCte(input.tables, {runIdParameter: 1})}
    UPDATE ${input.tables.runs} AS run
    SET status = CASE WHEN run.abort_requested_at IS NULL THEN 'completed' ELSE 'failed' END,
        finished_at = NOW(),
        error = CASE
          WHEN run.abort_requested_at IS NULL THEN NULL
          ELSE COALESCE(run.abort_reason, 'Run aborted before completion.')
        END
    FROM active_run
    WHERE run.id = active_run.id
    RETURNING run.*
  `, [input.runId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new ThreadRunClaimLostError(input.runId);
  }
  return parseRunRow(row);
}

export async function failOwnedThreadRun(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTables: SessionTableNames;
  runId: string;
  error?: string;
  notificationChannel: string;
}): Promise<ThreadRunRecord> {
  const result = await input.queryable.query(`
    WITH ${buildActiveThreadRunGuardCte(input.tables, {runIdParameter: 1})}, locked_thread AS MATERIALIZED (
      SELECT thread.id, thread.session_id
      FROM ${input.tables.threads} AS thread
      INNER JOIN active_run ON active_run.thread_id = thread.id
      FOR UPDATE OF thread
    ), failed_run AS (
      UPDATE ${input.tables.runs} AS run
      SET status = 'failed',
          finished_at = NOW(),
          error = $2
      FROM active_run
      WHERE run.id = active_run.id
      RETURNING run.*
    ), rearmed_inputs AS (
      -- Claim admission demotes wake inputs to queue. A provider/shutdown
      -- failure must make those inputs runnable again, but an explicit abort
      -- is a durable instruction to leave them dormant until a later wake.
      UPDATE ${input.tables.inputs} AS pending_input
      SET delivery_mode = 'wake',
          admitted_run_id = NULL
      FROM active_run
      INNER JOIN locked_thread AS thread
        ON thread.id = active_run.thread_id
      INNER JOIN ${input.sessionTables.sessions} AS session
        ON session.id = thread.session_id
       AND session.current_thread_id = thread.id
      WHERE active_run.abort_requested_at IS NULL
        AND pending_input.thread_id = active_run.thread_id
        AND pending_input.applied_at IS NULL
        AND pending_input.discarded_at IS NULL
        AND pending_input.admitted_run_id = active_run.id
      RETURNING pending_input.thread_id
    ), changed_threads AS (
      SELECT DISTINCT thread_id FROM rearmed_inputs
    ), woken_sessions AS (
      INSERT INTO ${input.sessionTables.sessionRuntimeConfig} (
        session_id,
        pending_wake_at,
        pending_wake_generation
      )
      SELECT thread.session_id, NOW(), 1
      FROM changed_threads
      INNER JOIN locked_thread AS thread
        ON thread.id = changed_threads.thread_id
      ON CONFLICT (session_id) DO UPDATE
      SET pending_wake_at = NOW(),
          pending_wake_generation = ${input.sessionTables.sessionRuntimeConfig}.pending_wake_generation + 1,
          updated_at = NOW()
      RETURNING session_id
    ), notified AS (
      SELECT pg_notify(
        $3,
        json_build_object('kind', 'thread_runnable', 'threadId', changed_threads.thread_id)::text
      ) AS notification
      FROM changed_threads
    )
    SELECT failed_run.*,
           (SELECT COUNT(*) FROM woken_sessions) AS woken_session_count,
           (SELECT COUNT(*) FROM notified) AS notification_count
    FROM failed_run
  `, [input.runId, input.error ?? null, input.notificationChannel]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    throw new ThreadRunClaimLostError(input.runId);
  }
  return parseRunRow(row);
}

export async function failOrphanedThreadRuns(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTables: SessionTableNames;
  owner: ThreadRunOwner;
  error: string;
  limit: number;
  notificationChannel: string;
}): Promise<readonly ThreadRunRecord[]> {
  const result = await input.queryable.query(`
    WITH current_owner AS MATERIALIZED (
      SELECT 1
      FROM ${POSTGRES_CONNECTOR_LEASE_TABLE}
      WHERE source = $1
        AND connector_key = $2
        AND holder_id = $3
        AND leased_until > NOW()
      FOR SHARE
    ), orphaned_run AS (
      SELECT run.id
      FROM ${input.tables.runs} AS run
      CROSS JOIN current_owner
      LEFT JOIN ${POSTGRES_CONNECTOR_LEASE_TABLE} AS owner_lease
        ON owner_lease.source = run.owner_source
       AND owner_lease.connector_key = run.owner_key
       AND owner_lease.holder_id = run.owner_holder_id
       AND owner_lease.leased_until > NOW()
      WHERE run.status = 'running'
        AND owner_lease.source IS NULL
      ORDER BY run.started_at ASC
      LIMIT $5
      FOR UPDATE OF run SKIP LOCKED
    ), failed_runs AS (
      UPDATE ${input.tables.runs} AS run
      SET status = 'failed',
          finished_at = NOW(),
          error = $4
      FROM orphaned_run
      WHERE run.id = orphaned_run.id
      RETURNING run.*
    ), locked_threads AS MATERIALIZED (
      SELECT thread.id, thread.session_id
      FROM ${input.tables.threads} AS thread
      INNER JOIN failed_runs ON failed_runs.thread_id = thread.id
      ORDER BY thread.id
      FOR UPDATE OF thread
    ), rearmed_inputs AS (
      -- Orphan recovery is the successor owner's terminal boundary. Re-arm
      -- work from crashed runs in the same transaction so no input can be
      -- stranded between failure recovery and a later wake notification.
      UPDATE ${input.tables.inputs} AS pending_input
      SET delivery_mode = 'wake',
          admitted_run_id = NULL
      FROM failed_runs
      INNER JOIN locked_threads AS thread
        ON thread.id = failed_runs.thread_id
      INNER JOIN ${input.sessionTables.sessions} AS session
        ON session.id = thread.session_id
       AND session.current_thread_id = thread.id
      WHERE failed_runs.abort_requested_at IS NULL
        AND pending_input.thread_id = failed_runs.thread_id
        AND pending_input.applied_at IS NULL
        AND pending_input.discarded_at IS NULL
        AND pending_input.admitted_run_id = failed_runs.id
      RETURNING pending_input.thread_id
    ), changed_threads AS (
      SELECT DISTINCT thread_id FROM rearmed_inputs
    ), woken_sessions AS (
      INSERT INTO ${input.sessionTables.sessionRuntimeConfig} (
        session_id,
        pending_wake_at,
        pending_wake_generation
      )
      SELECT thread.session_id, NOW(), 1
      FROM changed_threads
      INNER JOIN locked_threads AS thread
        ON thread.id = changed_threads.thread_id
      ON CONFLICT (session_id) DO UPDATE
      SET pending_wake_at = NOW(),
          pending_wake_generation = ${input.sessionTables.sessionRuntimeConfig}.pending_wake_generation + 1,
          updated_at = NOW()
      RETURNING session_id
    ), notified AS (
      SELECT pg_notify(
        $6,
        json_build_object('kind', 'thread_runnable', 'threadId', changed_threads.thread_id)::text
      ) AS notification
      FROM changed_threads
    )
    SELECT failed_runs.*,
           (SELECT COUNT(*) FROM woken_sessions) AS woken_session_count,
           (SELECT COUNT(*) FROM notified) AS notification_count
    FROM failed_runs
  `, [
    input.owner.source,
    input.owner.connectorKey,
    input.owner.holderId,
    input.error,
    input.limit,
    input.notificationChannel,
  ]);
  return result.rows.map((row) => parseRunRow(row as Record<string, unknown>));
}

export async function listRunnableThreadIds(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTables: SessionTableNames;
  limit: number;
}): Promise<readonly string[]> {
  const result = await input.queryable.query(`
    SELECT thread.id
    FROM ${input.tables.threads} AS thread
    INNER JOIN ${input.sessionTables.sessions} AS session
      ON session.id = thread.session_id
     AND session.current_thread_id = thread.id
    LEFT JOIN ${input.sessionTables.sessionRuntimeConfig} AS config
      ON config.session_id = session.id
    WHERE (
      config.pending_wake_at IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM ${input.tables.inputs} AS input
        WHERE input.thread_id = thread.id
          AND input.applied_at IS NULL
          AND input.discarded_at IS NULL
          AND input.delivery_mode = 'wake'
      )
    )
      AND NOT EXISTS (
        SELECT 1
        FROM ${input.tables.runs} AS run
        WHERE run.thread_id = thread.id
          AND run.status = 'running'
      )
    ORDER BY COALESCE(config.pending_wake_at, thread.updated_at), thread.id
    LIMIT $1
  `, [input.limit]);
  return result.rows.flatMap((row) => {
    const id = (row as {id?: unknown}).id;
    return typeof id === "string" && id ? [id] : [];
  });
}

export async function isRunnableThread(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTables: SessionTableNames;
  threadId: string;
}): Promise<boolean> {
  const result = await input.queryable.query(`
    SELECT EXISTS (
      SELECT 1
      FROM ${input.tables.threads} AS thread
      INNER JOIN ${input.sessionTables.sessions} AS session
        ON session.id = thread.session_id
       AND session.current_thread_id = thread.id
      LEFT JOIN ${input.sessionTables.sessionRuntimeConfig} AS config
        ON config.session_id = session.id
      WHERE thread.id = $1
        AND (
          config.pending_wake_at IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM ${input.tables.inputs} AS pending_input
            WHERE pending_input.thread_id = thread.id
              AND pending_input.applied_at IS NULL
              AND pending_input.discarded_at IS NULL
              AND pending_input.delivery_mode = 'wake'
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM ${input.tables.runs} AS run
          WHERE run.thread_id = thread.id
            AND run.status = 'running'
        )
    ) AS runnable
  `, [input.threadId]);
  return (result.rows[0] as {runnable?: unknown} | undefined)?.runnable === true;
}

export async function takeOwnedThreadRunBoundary(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  sessionTables: SessionTableNames;
  threadId: string;
  runId: string;
}): Promise<{hasRunnableInputs: boolean; hasAdmittedInputs: boolean; hadPendingWake: boolean}> {
  const result = await input.queryable.query(`
    WITH ${buildActiveThreadRunGuardCte(input.tables, {
      runIdParameter: 1,
      threadIdParameter: 2,
    })}, locked_thread AS MATERIALIZED (
      SELECT thread.id, thread.session_id
      FROM ${input.tables.threads} AS thread
      INNER JOIN active_run ON active_run.thread_id = thread.id
      WHERE thread.id = $2
      FOR UPDATE OF thread
    ), observed_wake AS MATERIALIZED (
      SELECT config.session_id, config.pending_wake_generation
      FROM ${input.sessionTables.sessionRuntimeConfig} AS config
      INNER JOIN locked_thread AS thread
        ON thread.session_id = config.session_id
      INNER JOIN ${input.sessionTables.sessions} AS session
        ON session.id = thread.session_id
       AND session.current_thread_id = thread.id
      WHERE config.pending_wake_at IS NOT NULL
    ), visible_wake_input AS MATERIALIZED (
      SELECT 1 AS present
      FROM ${input.tables.inputs} AS pending_input
      INNER JOIN locked_thread ON locked_thread.id = pending_input.thread_id
      WHERE pending_input.applied_at IS NULL
        AND pending_input.discarded_at IS NULL
        AND pending_input.delivery_mode = 'wake'
      LIMIT 1
    ), admission_edge AS MATERIALIZED (
      SELECT 1 AS present FROM observed_wake
      UNION ALL
      SELECT 1 AS present FROM visible_wake_input
      WHERE NOT EXISTS (SELECT 1 FROM observed_wake)
    ), admitted_inputs AS (
      -- A wake arriving during a run is another admission edge. The durable
      -- wake-row fallback also repairs an edge left by an older runtime. Admit
      -- the complete visible set so failure can re-arm exactly that set.
      UPDATE ${input.tables.inputs} AS pending_input
      SET delivery_mode = 'queue',
          admitted_run_id = active_run.id
      FROM active_run
      CROSS JOIN admission_edge
      WHERE pending_input.thread_id = active_run.thread_id
        AND pending_input.applied_at IS NULL
        AND pending_input.discarded_at IS NULL
      RETURNING pending_input.id
    ), admission_mutation AS MATERIALIZED (
      SELECT COUNT(*) AS admitted_count FROM admitted_inputs
    ), consumed_wake AS (
      UPDATE ${input.sessionTables.sessionRuntimeConfig} AS config
      SET pending_wake_at = NULL,
          updated_at = NOW()
      FROM observed_wake
      CROSS JOIN admission_mutation
      WHERE config.session_id = observed_wake.session_id
        AND config.pending_wake_generation = observed_wake.pending_wake_generation
      RETURNING config.session_id
    )
    SELECT
      EXISTS (
        SELECT 1
        FROM ${input.tables.inputs} AS pending_input
        INNER JOIN active_run ON active_run.thread_id = pending_input.thread_id
        WHERE pending_input.applied_at IS NULL
          AND pending_input.discarded_at IS NULL
          AND pending_input.delivery_mode = 'wake'
      ) AS has_runnable_inputs,
      (EXISTS (SELECT 1 FROM admitted_inputs) OR EXISTS (
        SELECT 1
        FROM ${input.tables.inputs} AS pending_input
        INNER JOIN active_run ON active_run.thread_id = pending_input.thread_id
        WHERE pending_input.applied_at IS NULL
          AND pending_input.discarded_at IS NULL
          AND pending_input.admitted_run_id = active_run.id
      )) AS has_admitted_inputs,
      EXISTS (SELECT 1 FROM observed_wake) AS had_pending_wake,
      EXISTS (SELECT 1 FROM active_run) AS run_active
  `, [input.runId, input.threadId]);
  const row = result.rows[0] as {
    has_runnable_inputs?: unknown;
    has_admitted_inputs?: unknown;
    had_pending_wake?: unknown;
    run_active?: unknown;
  } | undefined;
  if (!row || row.run_active !== true) {
    throw new ThreadRunClaimLostError(input.runId);
  }
  if (
    typeof row.has_runnable_inputs !== "boolean"
    || typeof row.has_admitted_inputs !== "boolean"
    || typeof row.had_pending_wake !== "boolean"
  ) {
    throw new Error("Invalid thread run boundary result.");
  }
  return {
    hasRunnableInputs: row.has_runnable_inputs,
    hasAdmittedInputs: row.has_admitted_inputs,
    hadPendingWake: row.had_pending_wake,
  };
}

export async function assertExclusiveThreadAccess(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  threadId: string;
  owner: ThreadRunOwner;
  /** The same transaction already acquired lockThreadRunOwner(). */
  ownerLockHeld?: boolean;
}): Promise<void> {
  const ownerLock = input.ownerLockHeld ? "" : "FOR SHARE";
  const result = await input.queryable.query(`
    WITH current_owner AS MATERIALIZED (
      SELECT source
      FROM ${POSTGRES_CONNECTOR_LEASE_TABLE}
      WHERE source = $2
        AND connector_key = $3
        AND holder_id = $4
        AND leased_until > NOW()
      -- Exclusive work on unrelated threads may proceed concurrently, while
      -- lease renewal or takeover waits for every fenced transaction.
      ${ownerLock}
    ), locked_thread AS (
      SELECT thread.id
      FROM ${input.tables.threads} AS thread
      CROSS JOIN current_owner
      WHERE thread.id = $1
      FOR UPDATE OF thread
    )
    SELECT EXISTS (
      SELECT 1
      FROM locked_thread
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${input.tables.runs} AS run
        WHERE run.thread_id = locked_thread.id
          AND run.status = 'running'
      )
    ) AS has_access
  `, [input.threadId, input.owner.source, input.owner.connectorKey, input.owner.holderId]);
  if ((result.rows[0] as {has_access?: unknown} | undefined)?.has_access !== true) {
    throw new Error(`Thread ${input.threadId} is not exclusively owned by this daemon.`);
  }
}

export async function markOrphanedThreadToolJobsLost(input: {
  queryable: PgQueryable;
  tables: ThreadRuntimeTableNames;
  owner: ThreadRunOwner;
  error: string;
  limit: number;
  notificationChannel: string;
}): Promise<number> {
  const result = await input.queryable.query(`
    WITH current_owner AS MATERIALIZED (
      SELECT 1
      FROM ${POSTGRES_CONNECTOR_LEASE_TABLE}
      WHERE source = $1
        AND connector_key = $2
        AND holder_id = $3
        AND leased_until > NOW()
      FOR SHARE
    ), orphaned_job AS (
      SELECT job.id, job.thread_id, job.started_at
      FROM ${input.tables.toolJobs} AS job
      CROSS JOIN current_owner
      LEFT JOIN ${POSTGRES_CONNECTOR_LEASE_TABLE} AS owner_lease
        ON owner_lease.source = job.owner_source
       AND owner_lease.connector_key = job.owner_key
       AND owner_lease.holder_id = job.owner_holder_id
       AND owner_lease.leased_until > NOW()
      WHERE job.status = 'running'
        AND owner_lease.source IS NULL
      ORDER BY job.started_at ASC, job.id ASC
      LIMIT $5
      FOR UPDATE OF job SKIP LOCKED
    ), updated_job AS (
      UPDATE ${input.tables.toolJobs} AS job
      SET status = 'lost',
          finished_at = NOW(),
          duration_ms = GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - orphaned_job.started_at)) * 1000)
          ),
          status_reason = COALESCE(job.status_reason, $4)
      FROM orphaned_job
      WHERE job.id = orphaned_job.id
      RETURNING job.thread_id
    ), updated_thread AS (
      UPDATE ${input.tables.threads} AS thread
      SET updated_at = NOW()
      FROM (SELECT DISTINCT thread_id FROM updated_job) AS changed
      WHERE thread.id = changed.thread_id
      RETURNING thread.id
    ), notified AS (
      SELECT pg_notify(
        $6,
        json_build_object('kind', 'thread_changed', 'threadId', updated_thread.id)::text
      ) AS notification
      FROM updated_thread
    )
    SELECT COUNT(*)::integer AS updated_count,
           (SELECT COUNT(*) FROM notified) AS notification_count
    FROM updated_job
  `, [
    input.owner.source,
    input.owner.connectorKey,
    input.owner.holderId,
    input.error,
    input.limit,
    input.notificationChannel,
  ]);
  const count = Number((result.rows[0] as {updated_count?: unknown} | undefined)?.updated_count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Invalid orphaned thread tool-job recovery count.");
  }
  return count;
}
