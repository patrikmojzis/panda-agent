import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_RUNTIME_OPERATION_RECEIPTS} from "../../../integrations/postgres/schema-versions/0005-runtime-operation-receipts.js";

/**
 * Runtime-request effects live exactly as long as their replay envelope. This
 * both bounds receipt growth and prevents a pruned request from leaving a
 * permanent idempotency tombstone behind.
 */
export const RUNTIME_OPERATION_RECEIPTS_MIGRATION: PostgresMigration = {
  ...PANDA_RUNTIME_OPERATION_RECEIPTS,
  apply: async ({queryable}) => {
    await queryable.query(`
      UPDATE "runtime"."runtime_requests"
      SET status = 'failed',
          error = 'Unsettled runtime request predates operation receipts and cannot be replayed safely.',
          claim_token = NULL,
          claim_expires_at = NULL,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE status = 'running'
         OR (
           status = 'pending'
           AND (
             updated_at > created_at
             OR kind = 'update_thread'
             OR (
               kind = 'reset_session'
               AND (
                 payload ? 'model'
                 OR payload ? 'thinking'
                 OR payload ? 'inferenceProjection'
               )
             )
           )
         );

      ALTER TABLE "runtime"."runtime_requests"
      ADD COLUMN "execution_attempts" INTEGER NOT NULL DEFAULT 0;

      ALTER TABLE "runtime"."runtime_requests"
      ADD CONSTRAINT "runtime_runtime_requests_execution_attempts_check"
      CHECK ("execution_attempts" >= 0);

      ALTER TABLE "runtime"."session_runtime_config"
      ADD COLUMN "model_applied_at" TIMESTAMPTZ,
      ADD COLUMN "model_operation_id" UUID,
      ADD COLUMN "thinking_applied_at" TIMESTAMPTZ,
      ADD COLUMN "thinking_operation_id" UUID,
      ADD COLUMN "inference_projection_applied_at" TIMESTAMPTZ,
      ADD COLUMN "inference_projection_operation_id" UUID;

      UPDATE "runtime"."session_runtime_config"
      SET "model_applied_at" = NOW(),
          "thinking_applied_at" = NOW(),
          "inference_projection_applied_at" = NOW();

      ALTER TABLE "runtime"."session_runtime_config"
      ALTER COLUMN "model_applied_at" SET NOT NULL,
      ALTER COLUMN "model_applied_at" SET DEFAULT TIMESTAMPTZ '1970-01-01 00:00:00+00',
      ALTER COLUMN "thinking_applied_at" SET NOT NULL,
      ALTER COLUMN "thinking_applied_at" SET DEFAULT TIMESTAMPTZ '1970-01-01 00:00:00+00',
      ALTER COLUMN "inference_projection_applied_at" SET NOT NULL,
      ALTER COLUMN "inference_projection_applied_at" SET DEFAULT TIMESTAMPTZ '1970-01-01 00:00:00+00';

      DELETE FROM "runtime"."thread_abort_operations" AS operation
      WHERE NOT EXISTS (
        SELECT 1
        FROM "runtime"."runtime_requests" AS request
        WHERE request."id" = operation."operation_id"
      );

      ALTER TABLE "runtime"."thread_abort_operations"
      ADD CONSTRAINT "runtime_thread_abort_operations_request_fk"
      FOREIGN KEY ("operation_id")
      REFERENCES "runtime"."runtime_requests"("id")
      ON DELETE CASCADE;

      CREATE INDEX "runtime_thread_abort_operations_thread_run_idx"
      ON "runtime"."thread_abort_operations" ("thread_id", "run_id");

      CREATE TABLE "runtime"."thread_compaction_noop_operations" (
        "operation_id" UUID PRIMARY KEY
          REFERENCES "runtime"."runtime_requests"("id") ON DELETE CASCADE,
        "session_id" TEXT NOT NULL,
        "thread_id" TEXT NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY ("session_id", "thread_id")
          REFERENCES "runtime"."threads"("session_id", "id") ON DELETE CASCADE
      );

      CREATE INDEX "runtime_thread_compaction_noop_operations_session_thread_idx"
      ON "runtime"."thread_compaction_noop_operations" ("session_id", "thread_id");

      CREATE TABLE "runtime"."session_runtime_config_operations" (
        "operation_id" UUID PRIMARY KEY
          REFERENCES "runtime"."runtime_requests"("id") ON DELETE CASCADE,
        "session_id" TEXT NOT NULL,
        "thread_id" TEXT NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY ("session_id", "thread_id")
          REFERENCES "runtime"."threads"("session_id", "id") ON DELETE CASCADE
      );

      CREATE INDEX "runtime_session_runtime_config_operations_session_thread_idx"
      ON "runtime"."session_runtime_config_operations" ("session_id", "thread_id");

      CREATE TABLE "runtime"."session_creation_operations" (
        "operation_id" UUID PRIMARY KEY
          REFERENCES "runtime"."runtime_requests"("id") ON DELETE CASCADE,
        "identity_id" TEXT NOT NULL,
        "agent_key" TEXT NOT NULL,
        "session_id" TEXT NOT NULL,
        "thread_id" TEXT NOT NULL,
        "kind" TEXT NOT NULL CHECK ("kind" IN ('main', 'branch', 'subagent')),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY ("session_id", "thread_id")
          REFERENCES "runtime"."threads"("session_id", "id") ON DELETE CASCADE
      );

      CREATE INDEX "runtime_session_creation_operations_session_thread_idx"
      ON "runtime"."session_creation_operations" ("session_id", "thread_id");
    `);
  },
};
