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
import {PANDA_SCHEDULED_COMMANDS} from "./schema-versions/0013-scheduled-commands.js";
import {PANDA_EMAIL_RECIPIENT_ALLOW_RULES} from "./schema-versions/0014-email-recipient-allow-rules.js";
import {PANDA_AGENT_LIVE_VOICE} from "./schema-versions/0015-agent-live-voice.js";
import {PANDA_WHATSAPP_CALL_CONTROLS} from "./schema-versions/0016-whatsapp-call-controls.js";
import {PANDA_CHANNEL_ACTION_EXPIRY} from "./schema-versions/0017-channel-action-expiry.js";
import {PANDA_SESSION_COMPACTION_REQUESTS} from "./schema-versions/0018-session-compaction-requests.js";
import {PANDA_HEARTBEAT_CADENCE} from "./schema-versions/0019-heartbeat-cadence.js";
import {PANDA_CHANNEL_RECEIPT_OWNERSHIP} from "./schema-versions/0020-channel-receipt-ownership.js";
import {PANDA_ENVIRONMENT_OPERATION_OWNERSHIP} from "./schema-versions/0021-environment-operation-ownership.js";
import {PANDA_WATCH_CLAIM_OWNERSHIP} from "./schema-versions/0022-watch-claim-ownership.js";
import {PANDA_GATEWAY_UPLOAD_RESERVATIONS} from "./schema-versions/0023-gateway-upload-reservations.js";
import {PANDA_GATEWAY_INPUT_RECEIPTS} from "./schema-versions/0024-gateway-input-receipts.js";
import {PANDA_RUNTIME_ERROR_SUMMARY} from "./schema-versions/0025-runtime-error-summary.js";

export const PANDA_PRE_LEDGER_BASELINE: PostgresMigrationSummary = Object.freeze({
  id: "0001_pre_ledger_baseline",
  description: "Install the final pre-ledger Panda schema",
  checksum: "f41ec637647ba4001dd46fd0c3fe81e32f38b93c00529db0e9737a28b7103ccf",
});

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
  PANDA_SCHEDULED_COMMANDS,
  PANDA_EMAIL_RECIPIENT_ALLOW_RULES,
  PANDA_AGENT_LIVE_VOICE,
  PANDA_WHATSAPP_CALL_CONTROLS,
  PANDA_CHANNEL_ACTION_EXPIRY,
  PANDA_SESSION_COMPACTION_REQUESTS,
  PANDA_HEARTBEAT_CADENCE,
  PANDA_CHANNEL_RECEIPT_OWNERSHIP,
  PANDA_ENVIRONMENT_OPERATION_OWNERSHIP,
  PANDA_WATCH_CLAIM_OWNERSHIP,
  PANDA_GATEWAY_UPLOAD_RESERVATIONS,
  PANDA_GATEWAY_INPUT_RECEIPTS,
  PANDA_RUNTIME_ERROR_SUMMARY,
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
