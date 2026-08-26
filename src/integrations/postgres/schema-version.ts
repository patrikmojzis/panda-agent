import {
  createPostgresMigrationVerifier,
  type PostgresMigrationSummary,
} from "../../lib/postgres-migrations.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {PANDA_THREAD_INPUT_ADMISSION} from "./schema-versions/0002-thread-input-admission.js";
import {PANDA_THREAD_WAKE_GENERATION} from "./schema-versions/0003-thread-wake-generation.js";
import {PANDA_THREAD_ABORT_OPERATIONS} from "./schema-versions/0004-thread-abort-operations.js";
import {PANDA_RUNTIME_OPERATION_RECEIPTS} from "./schema-versions/0005-runtime-operation-receipts.js";
import {PANDA_THREAD_INPUT_CUTOFFS} from "./schema-versions/0006-thread-input-cutoffs.js";
import {PANDA_RESET_RUN_FENCES} from "./schema-versions/0007-reset-run-fences.js";
import {PANDA_LEGACY_SCHEMA_RECONCILIATION} from "./schema-versions/0008-legacy-schema-reconciliation.js";
import {PANDA_SESSION_ARCHIVE} from "./schema-versions/0009-session-archive.js";
import {PANDA_REFRESH_ARCHIVED_SESSION_VIEW} from "./schema-versions/0010-refresh-archived-session-view.js";
import {PANDA_BOUND_SECRET_ENVELOPES} from "./schema-versions/0011-bound-secret-envelopes.js";
import {PANDA_CONTROL_IDENTITY_REVOCATION} from "./schema-versions/0012-control-identity-revocation.js";

export const PANDA_PRE_LEDGER_BASELINE: PostgresMigrationSummary = Object.freeze({
  id: "0001_pre_ledger_baseline",
  description: "Install the final pre-ledger Panda schema",
  checksum: "f41ec637647ba4001dd46fd0c3fe81e32f38b93c00529db0e9737a28b7103ccf",
});

export {PANDA_THREAD_INPUT_ADMISSION};
export {PANDA_THREAD_WAKE_GENERATION};
export {PANDA_THREAD_ABORT_OPERATIONS};
export {PANDA_RUNTIME_OPERATION_RECEIPTS};
export {PANDA_THREAD_INPUT_CUTOFFS};
export {PANDA_RESET_RUN_FENCES};
export {PANDA_LEGACY_SCHEMA_RECONCILIATION};
export {PANDA_SESSION_ARCHIVE};
export {PANDA_REFRESH_ARCHIVED_SESSION_VIEW};
export {PANDA_BOUND_SECRET_ENVELOPES};
export {PANDA_CONTROL_IDENTITY_REVOCATION};

export const PANDA_SCHEMA_VERSION = Object.freeze([
  PANDA_PRE_LEDGER_BASELINE,
  PANDA_THREAD_INPUT_ADMISSION,
  PANDA_THREAD_WAKE_GENERATION,
  PANDA_THREAD_ABORT_OPERATIONS,
  PANDA_RUNTIME_OPERATION_RECEIPTS,
  PANDA_THREAD_INPUT_CUTOFFS,
  PANDA_RESET_RUN_FENCES,
  PANDA_LEGACY_SCHEMA_RECONCILIATION,
  PANDA_SESSION_ARCHIVE,
  PANDA_REFRESH_ARCHIVED_SESSION_VIEW,
  PANDA_BOUND_SECRET_ENVELOPES,
  PANDA_CONTROL_IDENTITY_REVOCATION,
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
