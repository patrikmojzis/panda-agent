import {
  createPostgresMigrationVerifier,
  type PostgresMigrationSummary,
} from "../../lib/postgres-migrations.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";

export const PANDA_PRE_LEDGER_BASELINE: PostgresMigrationSummary = Object.freeze({
  id: "0001_pre_ledger_baseline",
  description: "Install the final pre-ledger Panda schema",
  checksum: "f41ec637647ba4001dd46fd0c3fe81e32f38b93c00529db0e9737a28b7103ccf",
});

export const PANDA_SCHEMA_VERSION = Object.freeze([
  PANDA_PRE_LEDGER_BASELINE,
]);

/** Read-only database revision seam shared by every Postgres-backed process. */
export function createPandaSchemaVerifier(pool: PgPoolLike) {
  return createPostgresMigrationVerifier({
    pool,
    migrations: PANDA_SCHEMA_VERSION,
    schemaName: "runtime",
    tableName: "schema_migrations",
  });
}
