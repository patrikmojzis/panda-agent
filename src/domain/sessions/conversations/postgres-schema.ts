import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../../lib/postgres-relations.js";

import {addConstraint, assertIntegrityChecks} from "../../../lib/postgres-integrity.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import {buildSessionTableNames} from "../postgres-shared.js";
import {buildConversationSessionTableNames} from "./postgres-shared.js";

export async function ensurePostgresConversationSessionSchema(pool: PgQueryable): Promise<void> {
  const tables = buildConversationSessionTableNames();
  const sessionTableName = buildSessionTableNames().sessions;

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.conversationSessions} (
      source TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, connector_key, external_conversation_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_conversation_sessions_session_id_idx`)}
    ON ${tables.conversationSessions} (session_id)
  `);
  await assertIntegrityChecks(pool, "Conversation binding schema", [
    {
      label: "conversation_sessions.session_id orphaned from agent_sessions.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.conversationSessions} AS binding
        LEFT JOIN ${sessionTableName} AS session
          ON session.id = binding.session_id
        WHERE session.id IS NULL
      `,
    },
  ]);
  await addConstraint(pool, `
    ALTER TABLE ${tables.conversationSessions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_conversation_sessions_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
}
