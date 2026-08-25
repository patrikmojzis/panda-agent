import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_THREAD_WAKE_GENERATION} from "../../../integrations/postgres/schema-versions/0003-thread-wake-generation.js";

/**
 * Turns the wake timestamp into observability only. The monotonic generation
 * is the compare-and-clear token: a consumer may clear exactly the wake it
 * observed, but cannot erase a concurrent wake that advanced the generation.
 */
export const THREAD_WAKE_GENERATION_MIGRATION: PostgresMigration = {
  ...PANDA_THREAD_WAKE_GENERATION,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."session_runtime_config"
      ADD COLUMN "pending_wake_generation" BIGINT NOT NULL DEFAULT 0;

      UPDATE "runtime"."session_runtime_config"
      SET "pending_wake_generation" = 1
      WHERE "pending_wake_at" IS NOT NULL;
    `);
  },
};
