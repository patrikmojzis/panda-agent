import type {PgQueryable} from "../../../lib/postgres-query.js";
import {addConstraint} from "../../../lib/postgres-integrity.js";
import {postgresRelationExists, quoteIdentifier} from "../../../lib/postgres-relations.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import {buildThreadRuntimeTableNames} from "../runtime/postgres-shared.js";
import {buildRuntimeRequestTableNames} from "./postgres-shared.js";

/**
 * Converges the test/bootstrap schema once requests, sessions, and threads all
 * exist. Production uses the immutable migration ledger; direct store tests
 * intentionally install those three domains in varying orders.
 */
export async function ensurePostgresRuntimeOperationReceiptSchema(
  pool: PgQueryable,
): Promise<void> {
  const dependencies = await Promise.all([
    postgresRelationExists(pool, "runtime", "runtime_requests"),
    postgresRelationExists(pool, "runtime", "agent_sessions"),
    postgresRelationExists(pool, "runtime", "threads"),
  ]);
  if (dependencies.some((exists) => !exists)) return;

  const requests = buildRuntimeRequestTableNames().runtimeRequests;
  const sessions = buildSessionTableNames();
  const threadTables = buildThreadRuntimeTableNames();
  const threads = threadTables.threads;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${sessions.sessionRuntimeConfigOperations} (
      operation_id UUID PRIMARY KEY REFERENCES ${requests}(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (session_id, thread_id)
        REFERENCES ${threads}(session_id, id) ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${sessions.sessionCreationOperations} (
      operation_id UUID PRIMARY KEY REFERENCES ${requests}(id) ON DELETE CASCADE,
      identity_id TEXT NOT NULL,
      agent_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('main', 'branch', 'subagent')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (session_id, thread_id)
        REFERENCES ${threads}(session_id, id) ON DELETE CASCADE
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${threadTables.abortOperations}
    ADD CONSTRAINT ${quoteIdentifier(`${threadTables.prefix}_thread_abort_operations_request_fk`)}
    FOREIGN KEY (operation_id)
    REFERENCES ${requests}(id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${threadTables.compactionNoopOperations}
    ADD CONSTRAINT ${quoteIdentifier(`${threadTables.prefix}_thread_compaction_noop_operations_request_fk`)}
    FOREIGN KEY (operation_id)
    REFERENCES ${requests}(id)
    ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${threadTables.prefix}_thread_abort_operations_thread_run_idx`)}
    ON ${threadTables.abortOperations} (thread_id, run_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${threadTables.prefix}_thread_compaction_noop_operations_session_thread_idx`)}
    ON ${threadTables.compactionNoopOperations} (session_id, thread_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${sessions.prefix}_session_runtime_config_operations_session_thread_idx`)}
    ON ${sessions.sessionRuntimeConfigOperations} (session_id, thread_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${sessions.prefix}_session_creation_operations_session_thread_idx`)}
    ON ${sessions.sessionCreationOperations} (session_id, thread_id)
  `);
}
