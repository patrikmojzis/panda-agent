import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier} from "../../../lib/postgres-relations.js";

import {buildThreadRuntimeTableNames} from "../../threads/runtime/postgres-shared.js";
import {addConstraint, assertIntegrityChecks, type IntegrityCheckGroup} from "../../../lib/postgres-integrity.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import {buildOutboundDeliveryTableNames} from "./postgres-shared.js";

export function buildOutboundDeliveryIntegrityChecks(): IntegrityCheckGroup {
  const tables = buildOutboundDeliveryTableNames();
  const threadTableName = buildThreadRuntimeTableNames().threads;
  return {
    scope: "Outbound delivery schema",
    checks: [{
      label: "outbound_deliveries.thread_id orphaned from threads.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.outboundDeliveries} AS delivery
        LEFT JOIN ${threadTableName} AS thread
          ON thread.id = delivery.thread_id
        WHERE delivery.thread_id IS NOT NULL
          AND thread.id IS NULL
      `,
    }],
  };
}

export async function ensurePostgresOutboundDeliverySchema(pool: PgQueryable): Promise<void> {
  const tables = buildOutboundDeliveryTableNames();
  const threadTableName = buildThreadRuntimeTableNames().threads;

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.outboundDeliveries} (
      id UUID PRIMARY KEY,
      idempotency_key TEXT,
      thread_id TEXT,
      channel TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      external_actor_id TEXT,
      reply_to_message_id TEXT,
      items JSONB NOT NULL,
      metadata JSONB,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_items JSONB,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.outboundDeliveries}
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_outbound_deliveries_idempotency_idx`)}
    ON ${tables.outboundDeliveries} (idempotency_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_outbound_deliveries_pending_idx`)}
    ON ${tables.outboundDeliveries} (channel, connector_key, status, created_at, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_outbound_deliveries_thread_idx`)}
    ON ${tables.outboundDeliveries} (thread_id, created_at DESC)
  `);
  const integrity = buildOutboundDeliveryIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await addConstraint(pool, `
    ALTER TABLE ${tables.outboundDeliveries}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_outbound_deliveries_thread_fk`)}
    FOREIGN KEY (thread_id)
    REFERENCES ${threadTableName}(id)
    ON DELETE SET NULL
  `);
}
