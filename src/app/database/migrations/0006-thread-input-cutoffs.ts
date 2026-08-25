import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_THREAD_INPUT_CUTOFFS} from "../../../integrations/postgres/schema-versions/0006-thread-input-cutoffs.js";

/**
 * A run admits a FIFO prefix, not a mutable set of input rows. The scalar
 * cutoff keeps claim and wake-boundary work constant regardless of backlog.
 */
export const THREAD_INPUT_CUTOFFS_MIGRATION: PostgresMigration = {
  ...PANDA_THREAD_INPUT_CUTOFFS,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."runs"
      ADD COLUMN "admitted_through_input_order" BIGINT;

      UPDATE "runtime"."runs" AS run
      SET "admitted_through_input_order" = admitted.input_order
      FROM (
        SELECT "admitted_run_id" AS run_id, MAX("input_order") AS input_order
        FROM "runtime"."inputs"
        WHERE "admitted_run_id" IS NOT NULL
          AND "applied_at" IS NULL
          AND "discarded_at" IS NULL
        GROUP BY "admitted_run_id"
      ) AS admitted
      WHERE run."id" = admitted.run_id;

      UPDATE "runtime"."inputs"
      SET "discarded_at" = NOW(),
          "metadata" = NULL,
          "message" = NULL
      WHERE "applied_at" IS NULL
        AND "discarded_at" IS NULL
        AND "delivery_mode" = 'wake'
        AND "source" IN ('subagent', 'a2a', 'worker', 'background_tool');

      INSERT INTO "runtime"."session_runtime_config" (
        "session_id",
        "pending_wake_at",
        "pending_wake_generation"
      )
      SELECT DISTINCT thread."session_id", NOW(), 1
      FROM "runtime"."inputs" AS input
      INNER JOIN "runtime"."threads" AS thread ON thread."id" = input."thread_id"
      INNER JOIN "runtime"."agent_sessions" AS session
        ON session."id" = thread."session_id"
       AND session."current_thread_id" = thread."id"
      WHERE input."applied_at" IS NULL
        AND input."discarded_at" IS NULL
        AND input."delivery_mode" = 'wake'
      ON CONFLICT ("session_id") DO UPDATE
      SET "pending_wake_at" = COALESCE(
            "runtime"."session_runtime_config"."pending_wake_at",
            EXCLUDED."pending_wake_at"
          ),
          "pending_wake_generation" = CASE
            WHEN "runtime"."session_runtime_config"."pending_wake_at" IS NULL
              THEN "runtime"."session_runtime_config"."pending_wake_generation" + 1
            ELSE "runtime"."session_runtime_config"."pending_wake_generation"
          END,
          "updated_at" = NOW();

      DROP INDEX "runtime"."runtime_inputs_admitted_idx";

      DROP INDEX "runtime"."runtime_inputs_runnable_idx";

      ALTER TABLE "runtime"."inputs"
      DROP CONSTRAINT "runtime_inputs_admission_lifecycle_check",
      DROP CONSTRAINT "runtime_inputs_admitted_run_scope_fk",
      DROP COLUMN "admitted_run_id";

      ALTER TABLE "runtime"."runs"
      ADD CONSTRAINT "runtime_runs_admission_cutoff_check"
      CHECK (
        "admitted_through_input_order" IS NULL
        OR "admitted_through_input_order" > 0
      );
    `);
  },
};
