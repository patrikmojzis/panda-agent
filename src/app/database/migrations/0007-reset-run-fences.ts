import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_RESET_RUN_FENCES} from "../../../integrations/postgres/schema-versions/0007-reset-run-fences.js";

/**
 * Reset cancellation is not the durable boundary. Retiring the old thread is
 * persisted on the thread itself so pruning the request and its receipt can
 * never reopen that thread for run admission.
 *
 * A pre-0007 reset could crash after writing its abort receipt but before
 * swapping the session pointer. There is no honest automatic completion for
 * that half-applied operation, so the hard cut rejects that unsafe upgrade
 * instead of silently admitting the aborted prefix again.
 */
export const RESET_RUN_FENCES_MIGRATION: PostgresMigration = {
  ...PANDA_RESET_RUN_FENCES,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."thread_abort_operations"
      ADD COLUMN "blocks_new_runs" BOOLEAN NOT NULL DEFAULT FALSE;

      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM "runtime"."thread_abort_operations" AS operation
          INNER JOIN "runtime"."runtime_requests" AS request
            ON request."id" = operation."operation_id"
           AND request."kind" = 'reset_session'
          INNER JOIN "runtime"."threads" AS thread
            ON thread."id" = operation."thread_id"
          INNER JOIN "runtime"."agent_sessions" AS session
            ON session."id" = thread."session_id"
           AND session."current_thread_id" = thread."id"
        ) THEN
          RAISE EXCEPTION 'Unsafe interrupted reset detected: a retained reset abort receipt still targets its session current thread';
        END IF;
      END
      $$;

      ALTER TABLE "runtime"."threads"
      ADD COLUMN "run_claims_blocked_at" TIMESTAMPTZ;

      CREATE INDEX "runtime_session_runtime_config_pending_wake_idx"
      ON "runtime"."session_runtime_config" ("pending_wake_at", "session_id")
      WHERE "pending_wake_at" IS NOT NULL;
    `);
  },
};
