import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_PRE_LEDGER_BASELINE} from "../../../integrations/postgres/schema-version.js";
import {applyPreLedgerBaseline} from "./pre-ledger/0001-pre-ledger-baseline.generated.js";

/**
 * Frozen schema installers retained only for lightweight database test setup.
 * Production does not import them: 0001 executes its vendored implementation,
 * and every later schema change belongs in a new migration.
 */
export const PRE_LEDGER_SCHEMA_FIXTURE_SOURCE_FILES = Object.freeze([
  "src/app/database/migrations/pre-ledger/daemon-state.ts",
  "src/app/database/migrations/pre-ledger/discord-voice.ts",
  "src/app/database/migrations/pre-ledger/live-voice.ts",
  "src/domain/a2a/postgres-schema.ts",
  "src/domain/agents/postgres-schema.ts",
  "src/domain/agents/telegram-stickers/postgres-schema.ts",
  "src/domain/apps/auth-schema.ts",
  "src/domain/channels/actions/postgres-schema.ts",
  "src/domain/channels/cursors/postgres-schema.ts",
  "src/domain/channels/deliveries/postgres-schema.ts",
  "src/domain/connector-leases/postgres-schema.ts",
  "src/domain/connectors/postgres-schema.ts",
  "src/domain/control/postgres-schema.ts",
  "src/domain/credentials/postgres-schema.ts",
  "src/domain/email/postgres-schema.ts",
  "src/domain/execution-environments/postgres-schema.ts",
  "src/domain/gateway/postgres-schema.ts",
  "src/domain/identity/postgres-schema.ts",
  "src/domain/mcp/postgres-schema.ts",
  "src/domain/model-call-traces/postgres-schema.ts",
  "src/domain/scheduling/tasks/postgres-schema.ts",
  "src/domain/sessions/conversations/postgres-schema.ts",
  "src/domain/sessions/postgres-schema.ts",
  "src/domain/sessions/routes/postgres-schema.ts",
  "src/domain/subagents/postgres-schema.ts",
  "src/domain/threads/requests/postgres-schema.ts",
  "src/domain/threads/runtime/postgres-readonly.ts",
  "src/domain/threads/runtime/postgres-schema.ts",
  "src/domain/watches/postgres-schema.ts",
  "src/domain/wiki/postgres-schema.ts",
  "src/integrations/channels/whatsapp/auth-schema.ts",
]);

/**
 * Frozen bridge from every pre-ledger Panda schema to the global ledger.
 * Never add new product schema here after release; append a new migration.
 */
export const PRE_LEDGER_BASELINE_MIGRATION: PostgresMigration = {
  ...PANDA_PRE_LEDGER_BASELINE,
  apply: ({queryable}) => applyPreLedgerBaseline(queryable),
};
