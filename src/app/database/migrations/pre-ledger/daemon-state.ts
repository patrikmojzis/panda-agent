import {buildRuntimeRelationNames, CREATE_RUNTIME_SCHEMA_SQL} from "../../../../lib/postgres-relations.js";
import type {PgQueryable} from "../../../../lib/postgres-query.js";

/** Frozen daemon-state DDL absorbed by the pre-ledger baseline. */
export async function installPreLedgerDaemonStateSchema(queryable: PgQueryable): Promise<void> {
  const daemonStateTable = buildRuntimeRelationNames({daemonState: "daemon_state"}).daemonState;
  await queryable.query(CREATE_RUNTIME_SCHEMA_SQL);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS ${daemonStateTable} (
      daemon_key TEXT PRIMARY KEY,
      heartbeat_at TIMESTAMPTZ NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
