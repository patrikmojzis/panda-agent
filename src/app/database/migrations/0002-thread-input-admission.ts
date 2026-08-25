import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_THREAD_INPUT_ADMISSION} from "../../../integrations/postgres/schema-versions/0002-thread-input-admission.js";

/**
 * Separates durable run admission from caller-selected queue/wake policy.
 * Writers are stopped for migrations, so the nullable column is immediately
 * safe for existing pending inputs: no pre-migration run can still own them.
 */
export const THREAD_INPUT_ADMISSION_MIGRATION: PostgresMigration = {
  ...PANDA_THREAD_INPUT_ADMISSION,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."inputs"
      ADD COLUMN "admitted_run_id" UUID;

      -- 0001 runtimes did not persist admission identity. Preserve their
      -- recovery boundary by assigning every still-pending input on an
      -- interrupted thread to its one durable running run. Startup orphan
      -- recovery can then re-arm non-aborted work and keep aborted work
      -- dormant using the same rules as native 0002 claims.
      UPDATE "runtime"."inputs" AS pending_input
      SET "delivery_mode" = 'queue',
          "admitted_run_id" = running_run."id"
      FROM "runtime"."runs" AS running_run
      WHERE running_run."thread_id" = pending_input."thread_id"
        AND running_run."status" = 'running'
        AND pending_input."applied_at" IS NULL
        AND pending_input."discarded_at" IS NULL;

      CREATE INDEX "runtime_inputs_admitted_idx"
      ON "runtime"."inputs" ("thread_id", "admitted_run_id", "input_order")
      WHERE "applied_at" IS NULL
        AND "discarded_at" IS NULL
        AND "admitted_run_id" IS NOT NULL;

      ALTER TABLE "runtime"."inputs"
      ADD CONSTRAINT "runtime_inputs_admission_lifecycle_check"
      CHECK (
        "admitted_run_id" IS NULL
        OR ("applied_at" IS NULL AND "discarded_at" IS NULL AND "message" IS NOT NULL)
      );

      ALTER TABLE "runtime"."inputs"
      ADD CONSTRAINT "runtime_inputs_admitted_run_scope_fk"
      FOREIGN KEY ("thread_id", "admitted_run_id")
      REFERENCES "runtime"."runs" ("thread_id", "id");
    `);
  },
};
