import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_CHANNEL_ACTION_EXPIRY} from "../../../integrations/postgres/schema-versions/0017-channel-action-expiry.js";

export const CHANNEL_ACTION_EXPIRY_MIGRATION: PostgresMigration = {
  ...PANDA_CHANNEL_ACTION_EXPIRY,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."channel_actions"
        ADD COLUMN "expires_at" TIMESTAMPTZ;

      UPDATE "runtime"."channel_actions"
      SET status = 'expired',
          last_error = 'Action expired before dispatch.',
          completed_at = NOW(),
          updated_at = NOW()
      WHERE status = 'pending'
        AND kind = 'typing';
    `);
  },
};
