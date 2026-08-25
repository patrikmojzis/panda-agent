import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {addConstraint, assertIntegrityChecks, type IntegrityCheckGroup} from "../../lib/postgres-integrity.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildA2ATableNames} from "./postgres-shared.js";

export function buildA2AIntegrityChecks(): IntegrityCheckGroup {
  const tables = buildA2ATableNames();
  const sessionTableName = buildSessionTableNames().sessions;
  return {
    scope: "A2A binding schema",
    checks: [
      {
        label: "a2a_session_bindings.sender_session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables.a2aSessionBindings} AS binding
          LEFT JOIN ${sessionTableName} AS sender
            ON sender.id = binding.sender_session_id
          WHERE sender.id IS NULL
        `,
      },
      {
        label: "a2a_session_bindings.recipient_session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables.a2aSessionBindings} AS binding
          LEFT JOIN ${sessionTableName} AS recipient
            ON recipient.id = binding.recipient_session_id
          WHERE recipient.id IS NULL
        `,
      },
    ],
  };
}

export async function ensurePostgresA2ASessionBindingSchema(pool: PgQueryable): Promise<void> {
  const tables = buildA2ATableNames();
  const sessionTableName = buildSessionTableNames().sessions;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.a2aSessionBindings} (
      sender_session_id TEXT NOT NULL,
      recipient_session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (sender_session_id, recipient_session_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_bindings_sender_idx`)}
    ON ${tables.a2aSessionBindings} (sender_session_id, updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_bindings_recipient_idx`)}
    ON ${tables.a2aSessionBindings} (recipient_session_id, updated_at DESC)
  `);
  const integrity = buildA2AIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await addConstraint(pool, `
    ALTER TABLE ${tables.a2aSessionBindings}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_session_bindings_sender_session_fk`)}
    FOREIGN KEY (sender_session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.a2aSessionBindings}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_session_bindings_recipient_session_fk`)}
    FOREIGN KEY (recipient_session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
}
