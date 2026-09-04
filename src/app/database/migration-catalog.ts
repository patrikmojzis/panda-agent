import type {PostgresMigrationLog} from "../../lib/postgres-migrations.js";
import {createPostgresMigrator} from "../../lib/postgres-migrations.js";
import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {PRE_LEDGER_BASELINE_MIGRATION} from "./migrations/0001-pre-ledger-baseline.js";
import {THREAD_INPUT_ADMISSION_MIGRATION} from "./migrations/0002-thread-input-admission.js";
import {THREAD_WAKE_GENERATION_MIGRATION} from "./migrations/0003-thread-wake-generation.js";
import {THREAD_ABORT_OPERATIONS_MIGRATION} from "./migrations/0004-thread-abort-operations.js";
import {RUNTIME_OPERATION_RECEIPTS_MIGRATION} from "./migrations/0005-runtime-operation-receipts.js";
import {THREAD_INPUT_CUTOFFS_MIGRATION} from "./migrations/0006-thread-input-cutoffs.js";
import {RESET_RUN_FENCES_MIGRATION} from "./migrations/0007-reset-run-fences.js";
import {LEGACY_SCHEMA_RECONCILIATION_MIGRATION} from "./migrations/0008-legacy-schema-reconciliation.js";
import {SESSION_ARCHIVE_MIGRATION} from "./migrations/0009-session-archive.js";
import {REFRESH_ARCHIVED_SESSION_VIEW_MIGRATION} from "./migrations/0010-refresh-archived-session-view.js";
import {BOUND_SECRET_ENVELOPES_MIGRATION} from "./migrations/0011-bound-secret-envelopes.js";
import {CONTROL_IDENTITY_REVOCATION_MIGRATION} from "./migrations/0012-control-identity-revocation.js";
import {SCHEDULED_COMMANDS_MIGRATION} from "./migrations/0013-scheduled-commands.js";
import {EMAIL_RECIPIENT_ALLOW_RULES_MIGRATION} from "./migrations/0014-email-recipient-allow-rules.js";
import {AGENT_LIVE_VOICE_MIGRATION} from "./migrations/0015-agent-live-voice.js";
import {WHATSAPP_CALL_CONTROLS_MIGRATION} from "./migrations/0016-whatsapp-call-controls.js";
import {CHANNEL_ACTION_EXPIRY_MIGRATION} from "./migrations/0017-channel-action-expiry.js";
import {SESSION_COMPACTION_REQUESTS_MIGRATION} from "./migrations/0018-session-compaction-requests.js";
import {HEARTBEAT_CADENCE_MIGRATION} from "./migrations/0019-heartbeat-cadence.js";
import {reconcileReadonlySessionRole} from "./readonly-role.js";

export const PANDA_SCHEMA_MIGRATIONS = Object.freeze([
  PRE_LEDGER_BASELINE_MIGRATION,
  THREAD_INPUT_ADMISSION_MIGRATION,
  THREAD_WAKE_GENERATION_MIGRATION,
  THREAD_ABORT_OPERATIONS_MIGRATION,
  RUNTIME_OPERATION_RECEIPTS_MIGRATION,
  THREAD_INPUT_CUTOFFS_MIGRATION,
  RESET_RUN_FENCES_MIGRATION,
  LEGACY_SCHEMA_RECONCILIATION_MIGRATION,
  SESSION_ARCHIVE_MIGRATION,
  REFRESH_ARCHIVED_SESSION_VIEW_MIGRATION,
  BOUND_SECRET_ENVELOPES_MIGRATION,
  CONTROL_IDENTITY_REVOCATION_MIGRATION,
  SCHEDULED_COMMANDS_MIGRATION,
  EMAIL_RECIPIENT_ALLOW_RULES_MIGRATION,
  AGENT_LIVE_VOICE_MIGRATION,
  WHATSAPP_CALL_CONTROLS_MIGRATION,
  CHANNEL_ACTION_EXPIRY_MIGRATION,
  SESSION_COMPACTION_REQUESTS_MIGRATION,
  HEARTBEAT_CADENCE_MIGRATION,
]);

/** Entry points bundled by CI to prove every persisted checksum matches code. */
export const PANDA_SCHEMA_MIGRATION_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  "0001_pre_ledger_baseline": "src/app/database/migrations/0001-pre-ledger-baseline.ts",
  "0002_thread_input_admission": "src/app/database/migrations/0002-thread-input-admission.ts",
  "0003_thread_wake_generation": "src/app/database/migrations/0003-thread-wake-generation.ts",
  "0004_thread_abort_operations": "src/app/database/migrations/0004-thread-abort-operations.ts",
  "0005_runtime_operation_receipts": "src/app/database/migrations/0005-runtime-operation-receipts.ts",
  "0006_thread_input_cutoffs": "src/app/database/migrations/0006-thread-input-cutoffs.ts",
  "0007_reset_run_fences": "src/app/database/migrations/0007-reset-run-fences.ts",
  "0008_legacy_schema_reconciliation": "src/app/database/migrations/0008-legacy-schema-reconciliation.ts",
  "0009_archive_session": "src/app/database/migrations/0009-session-archive.ts",
  "0010_refresh_archived_session_view": "src/app/database/migrations/0010-refresh-archived-session-view.ts",
  "0011_bound_secret_envelopes": "src/app/database/migrations/0011-bound-secret-envelopes.ts",
  "0012_control_identity_revocation": "src/app/database/migrations/0012-control-identity-revocation.ts",
  "0013_scheduled_commands": "src/app/database/migrations/0013-scheduled-commands.ts",
  "0014_email_recipient_allow_rules": "src/app/database/migrations/0014-email-recipient-allow-rules.ts",
  "0015_agent_live_voice": "src/app/database/migrations/0015-agent-live-voice.ts",
  "0016_whatsapp_call_controls": "src/app/database/migrations/0016-whatsapp-call-controls.ts",
  "0017_channel_action_expiry": "src/app/database/migrations/0017-channel-action-expiry.ts",
  "0018_session_compaction_requests": "src/app/database/migrations/0018-session-compaction-requests.ts",
  "0019_heartbeat_cadence": "src/app/database/migrations/0019-heartbeat-cadence.ts",
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
