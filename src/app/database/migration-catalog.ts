import type {PostgresMigrationLog} from "../../lib/postgres-migrations.js";
import {createPostgresMigrator} from "../../lib/postgres-migrations.js";
import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {PRE_LEDGER_BASELINE_MIGRATION} from "./migrations/0001-pre-ledger-baseline.js";
import {THREAD_INPUT_ADMISSION_MIGRATION} from "./migrations/0002-thread-input-admission.js";
import {THREAD_WAKE_GENERATION_MIGRATION} from "./migrations/0003-thread-wake-generation.js";
import {reconcileReadonlySessionRole} from "./readonly-role.js";

export const PANDA_SCHEMA_MIGRATIONS = Object.freeze([
  PRE_LEDGER_BASELINE_MIGRATION,
  THREAD_INPUT_ADMISSION_MIGRATION,
  THREAD_WAKE_GENERATION_MIGRATION,
]);

/** Entry points bundled by CI to prove every persisted checksum matches code. */
export const PANDA_SCHEMA_MIGRATION_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  "0001_pre_ledger_baseline": "src/app/database/migrations/0001-pre-ledger-baseline.ts",
  "0002_thread_input_admission": "src/app/database/migrations/0002-thread-input-admission.ts",
  "0003_thread_wake_generation": "src/app/database/migrations/0003-thread-wake-generation.ts",
});

export interface CreatePandaSchemaMigratorOptions {
  pool: PgPoolLike;
  /** undefined preserves deployment configuration; null explicitly removes it. */
  readonlyRole?: string | null;
  log?: PostgresMigrationLog;
}

/** The only composition root for Panda's concrete Postgres schema history. */
export function createPandaSchemaMigrator(options: CreatePandaSchemaMigratorOptions) {
  return createPostgresMigrator({
    pool: options.pool,
    migrations: PANDA_SCHEMA_MIGRATIONS,
    schemaName: "runtime",
    tableName: "schema_migrations",
    lockName: "panda:schema-migrations",
    ...(options.log ? {log: options.log} : {}),
    ...(options.readonlyRole === undefined
      ? {}
      : {
          reconcile: ({queryable}: {queryable: PgQueryable}) => (
            reconcileReadonlySessionRole(queryable, options.readonlyRole ?? null)
          ),
        }),
  });
}
