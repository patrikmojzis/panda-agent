import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_WATCH_CLAIM_OWNERSHIP} from "../../../integrations/postgres/schema-versions/0022-watch-claim-ownership.js";

export const WATCH_CLAIM_OWNERSHIP_MIGRATION: PostgresMigration = {
  ...PANDA_WATCH_CLAIM_OWNERSHIP,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."watches" ADD COLUMN claim_run_id UUID;
      UPDATE "runtime"."watch_runs"
      SET status = 'failed', finished_at = clock_timestamp(),
          error = 'Legacy watch claim retired by migration0022: ownership unavailable; outcome not inferred and not replayed.'
      WHERE status IN ('claimed', 'running');
      UPDATE "runtime"."watches"
      SET claimed_at = NULL, claimed_by = NULL, claim_expires_at = NULL,
          last_error = 'Legacy watch claim retired by migration0022: ownership unavailable; outcome not inferred and not replayed.',
          updated_at = clock_timestamp()
      WHERE claimed_at IS NOT NULL OR claimed_by IS NOT NULL OR claim_expires_at IS NOT NULL;
    `);
  },
};
