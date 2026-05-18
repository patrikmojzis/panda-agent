import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../lib/postgres-relations.js";

import {addConstraint, assertIntegrityChecks} from "../../lib/postgres-integrity.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {
    buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildWatchTableNames} from "./postgres-shared.js";

/** Ensures watch storage schema, migrations, and cross-table integrity constraints. */
export async function ensurePostgresWatchSchema(pool: PgPoolLike): Promise<void> {
  const tables = buildWatchTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;
  const threadTableName = buildThreadRuntimeTableNames().threads;

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.watches} (
      id UUID PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      source_config JSONB NOT NULL,
      detector_config JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      next_poll_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      claim_expires_at TIMESTAMPTZ,
      cooldown_until TIMESTAMPTZ,
      last_error TEXT,
      state JSONB,
      disabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_watches_due_idx`)}
    ON ${tables.watches} (enabled, disabled_at, next_poll_at, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_watches_identity_agent_idx`)}
    ON ${tables.watches} (session_id, created_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_watches_session_id_id_idx`)}
    ON ${tables.watches} (session_id, id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.watchRuns} (
      id UUID PRIMARY KEY,
      watch_id UUID NOT NULL REFERENCES ${tables.watches}(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      resolved_thread_id TEXT,
      resolved_thread_session_id TEXT,
      emitted_event_watch_id UUID,
      emitted_event_id UUID,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_watch_runs_watch_created_idx`)}
    ON ${tables.watchRuns} (watch_id, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.watchEvents} (
      id UUID PRIMARY KEY,
      watch_id UUID NOT NULL REFERENCES ${tables.watches}(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      resolved_thread_id TEXT,
      resolved_thread_session_id TEXT,
      event_kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_watch_events_dedupe_idx`)}
    ON ${tables.watchEvents} (watch_id, dedupe_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_watch_events_watch_created_idx`)}
    ON ${tables.watchEvents} (watch_id, created_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_watch_events_watch_id_id_idx`)}
    ON ${tables.watchEvents} (watch_id, id)
  `);
  await pool.query(`
    ALTER TABLE ${tables.watchRuns}
    ADD COLUMN IF NOT EXISTS resolved_thread_session_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables.watchRuns}
    ADD COLUMN IF NOT EXISTS emitted_event_watch_id UUID
  `);
  await pool.query(`
    ALTER TABLE ${tables.watchEvents}
    ADD COLUMN IF NOT EXISTS resolved_thread_session_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables.watchEvents}
    ALTER COLUMN resolved_thread_id DROP NOT NULL
  `);
  await assertIntegrityChecks(pool, "Watch schema", [
    {
      label: "watch_runs.watch_id orphaned from watches.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.watchRuns} AS run
        LEFT JOIN ${tables.watches} AS watch
          ON watch.id = run.watch_id
        WHERE watch.id IS NULL
      `,
    },
    {
      label: "watch_runs watch/session mismatch",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.watchRuns} AS run
        INNER JOIN ${tables.watches} AS watch
          ON watch.id = run.watch_id
        WHERE watch.session_id <> run.session_id
      `,
    },
    {
      label: "watch_runs.resolved_thread_id orphaned from threads.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.watchRuns} AS run
        LEFT JOIN ${threadTableName} AS thread
          ON thread.id = run.resolved_thread_id
        WHERE run.resolved_thread_id IS NOT NULL
          AND thread.id IS NULL
      `,
    },
    {
      label: "watch_runs.resolved_thread_id bound to another session",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.watchRuns} AS run
        INNER JOIN ${threadTableName} AS thread
          ON thread.id = run.resolved_thread_id
        WHERE run.resolved_thread_id IS NOT NULL
          AND thread.session_id <> run.session_id
      `,
    },
    {
      label: "watch_runs.emitted_event_id orphaned from watch_events.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.watchRuns} AS run
        LEFT JOIN ${tables.watchEvents} AS event
          ON event.id = run.emitted_event_id
        WHERE run.emitted_event_id IS NOT NULL
          AND event.id IS NULL
      `,
    },
    {
      label: "watch_runs.emitted_event_id bound to another watch",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.watchRuns} AS run
        INNER JOIN ${tables.watchEvents} AS event
          ON event.id = run.emitted_event_id
        WHERE run.emitted_event_id IS NOT NULL
          AND event.watch_id <> run.watch_id
      `,
    },
    {
      label: "watch_events watch/session mismatch",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.watchEvents} AS event
        INNER JOIN ${tables.watches} AS watch
          ON watch.id = event.watch_id
        WHERE watch.session_id <> event.session_id
      `,
    },
    {
      label: "watch_events.resolved_thread_id orphaned from threads.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.watchEvents} AS event
        LEFT JOIN ${threadTableName} AS thread
          ON thread.id = event.resolved_thread_id
        WHERE event.resolved_thread_id IS NOT NULL
          AND thread.id IS NULL
      `,
    },
    {
      label: "watch_events.resolved_thread_id bound to another session",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.watchEvents} AS event
        INNER JOIN ${threadTableName} AS thread
          ON thread.id = event.resolved_thread_id
        WHERE event.resolved_thread_id IS NOT NULL
          AND thread.session_id <> event.session_id
      `,
    },
  ]);
  await pool.query(`
    UPDATE ${tables.watchRuns}
    SET resolved_thread_session_id = NULL
    WHERE resolved_thread_id IS NULL
      AND resolved_thread_session_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables.watchRuns}
    SET resolved_thread_session_id = thread.session_id
    FROM ${threadTableName} AS thread
    WHERE ${tables.watchRuns}.resolved_thread_id IS NOT NULL
      AND thread.id = ${tables.watchRuns}.resolved_thread_id
      AND (
        ${tables.watchRuns}.resolved_thread_session_id IS NULL
        OR ${tables.watchRuns}.resolved_thread_session_id <> thread.session_id
      )
  `);
  await pool.query(`
    UPDATE ${tables.watchRuns}
    SET emitted_event_watch_id = NULL
    WHERE emitted_event_id IS NULL
      AND emitted_event_watch_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables.watchRuns}
    SET emitted_event_watch_id = event.watch_id
    FROM ${tables.watchEvents} AS event
    WHERE ${tables.watchRuns}.emitted_event_id IS NOT NULL
      AND event.id = ${tables.watchRuns}.emitted_event_id
      AND (
        ${tables.watchRuns}.emitted_event_watch_id IS NULL
        OR ${tables.watchRuns}.emitted_event_watch_id <> event.watch_id
      )
  `);
  await pool.query(`
    UPDATE ${tables.watchEvents}
    SET resolved_thread_session_id = NULL
    WHERE resolved_thread_id IS NULL
      AND resolved_thread_session_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables.watchEvents}
    SET resolved_thread_session_id = thread.session_id
    FROM ${threadTableName} AS thread
    WHERE ${tables.watchEvents}.resolved_thread_id IS NOT NULL
      AND thread.id = ${tables.watchEvents}.resolved_thread_id
      AND (
        ${tables.watchEvents}.resolved_thread_session_id IS NULL
        OR ${tables.watchEvents}.resolved_thread_session_id <> thread.session_id
      )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_runs_watch_scope_fk`)}
    FOREIGN KEY (session_id, watch_id)
    REFERENCES ${tables.watches}(session_id, id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_runs_resolved_thread_fk`)}
    FOREIGN KEY (resolved_thread_id)
    REFERENCES ${threadTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_runs_emitted_event_fk`)}
    FOREIGN KEY (emitted_event_id)
    REFERENCES ${tables.watchEvents}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_runs_emitted_event_scope_check`)}
    CHECK (
      (
        emitted_event_id IS NULL
        AND emitted_event_watch_id IS NULL
      ) OR (
        emitted_event_id IS NOT NULL
        AND emitted_event_watch_id = watch_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_runs_emitted_event_scope_fk`)}
    FOREIGN KEY (emitted_event_watch_id, emitted_event_id)
    REFERENCES ${tables.watchEvents}(watch_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_runs_resolved_thread_scope_check`)}
    CHECK (
      (
        resolved_thread_id IS NULL
        AND resolved_thread_session_id IS NULL
      ) OR (
        resolved_thread_id IS NOT NULL
        AND resolved_thread_session_id = session_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_runs_resolved_thread_scope_fk`)}
    FOREIGN KEY (resolved_thread_session_id, resolved_thread_id)
    REFERENCES ${threadTableName}(session_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchEvents}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_events_watch_scope_fk`)}
    FOREIGN KEY (session_id, watch_id)
    REFERENCES ${tables.watches}(session_id, id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchEvents}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_events_resolved_thread_fk`)}
    FOREIGN KEY (resolved_thread_id)
    REFERENCES ${threadTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchEvents}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_events_resolved_thread_scope_check`)}
    CHECK (
      (
        resolved_thread_id IS NULL
        AND resolved_thread_session_id IS NULL
      ) OR (
        resolved_thread_id IS NOT NULL
        AND resolved_thread_session_id = session_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.watchEvents}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_watch_events_resolved_thread_scope_fk`)}
    FOREIGN KEY (resolved_thread_session_id, resolved_thread_id)
    REFERENCES ${threadTableName}(session_id, id)
    ON DELETE SET NULL
  `);
}
