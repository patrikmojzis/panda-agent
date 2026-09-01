import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL, postgresRelationExists} from "../../../lib/postgres-relations.js";

import {type PgQueryable} from "../../../lib/postgres-query.js";
import {buildChannelActionTableNames} from "./postgres-shared.js";
import {addConstraint, assertIntegrityChecks} from "../../../lib/postgres-integrity.js";
import {buildSessionTableNames} from "../../sessions/postgres-shared.js";
import {buildThreadRuntimeTableNames} from "../../threads/runtime/postgres-shared.js";

export async function ensurePostgresChannelActionSchema(pool: PgQueryable): Promise<void> {
  const tables = buildChannelActionTableNames();
  const sessionTable = buildSessionTableNames().sessions;
  const threadTable = buildThreadRuntimeTableNames().threads;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.channelActions} (
      id UUID PRIMARY KEY,
      session_id TEXT,
      thread_id TEXT,
      channel TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.channelActions}
    ADD COLUMN IF NOT EXISTS session_id TEXT,
    ADD COLUMN IF NOT EXISTS thread_id TEXT,
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_channel_actions_pending_idx`)}
    ON ${tables.channelActions} (channel, connector_key, status, created_at, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_channel_actions_session_pending_idx`)}
    ON ${tables.channelActions} (session_id, status, created_at, id)
    WHERE session_id IS NOT NULL
  `);
  if (
    !await postgresRelationExists(pool, "runtime", "agent_sessions")
    || !await postgresRelationExists(pool, "runtime", "threads")
  ) return;
  await assertIntegrityChecks(pool, "Channel action schema", [{
    label: "channel_actions session/thread ownership mismatch",
    sql: `
      SELECT COUNT(*)::INTEGER AS count
      FROM ${tables.channelActions} AS action
      LEFT JOIN ${sessionTable} AS session ON session.id = action.session_id
      LEFT JOIN ${threadTable} AS thread ON thread.id = action.thread_id
      WHERE (action.session_id IS NOT NULL AND session.id IS NULL)
         OR (action.thread_id IS NOT NULL AND (thread.id IS NULL OR action.session_id IS NULL OR thread.session_id <> action.session_id))
    `,
  }]);
  await addConstraint(pool, `
    ALTER TABLE ${tables.channelActions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_channel_actions_session_fk`)}
    FOREIGN KEY (session_id) REFERENCES ${sessionTable}(id) ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.channelActions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_channel_actions_thread_fk`)}
    FOREIGN KEY (thread_id) REFERENCES ${threadTable}(id) ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.channelActions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_channel_actions_thread_requires_session_check`)}
    CHECK (thread_id IS NULL OR session_id IS NOT NULL)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.channelActions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_channel_actions_session_thread_fk`)}
    FOREIGN KEY (session_id, thread_id)
    REFERENCES ${threadTable}(session_id, id)
    ON DELETE SET NULL
  `);
}
