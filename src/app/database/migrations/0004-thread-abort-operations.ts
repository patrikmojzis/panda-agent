import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_THREAD_ABORT_OPERATIONS} from "../../../integrations/postgres/schema-versions/0004-thread-abort-operations.js";

/**
 * Records both targeted runs and intentional no-op aborts. A replay therefore
 * cannot drift from its original target to whichever run happens to be active.
 */
export const THREAD_ABORT_OPERATIONS_MIGRATION: PostgresMigration = {
  ...PANDA_THREAD_ABORT_OPERATIONS,
  apply: async ({queryable}) => {
    await queryable.query(`
      CREATE TABLE "runtime"."thread_abort_operations" (
        "operation_id" UUID PRIMARY KEY,
        "thread_id" TEXT NOT NULL REFERENCES "runtime"."threads"("id") ON DELETE CASCADE,
        "run_id" UUID,
        "reason" TEXT NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        FOREIGN KEY ("thread_id", "run_id") REFERENCES "runtime"."runs"("thread_id", "id")
      );
    `);
  },
};
