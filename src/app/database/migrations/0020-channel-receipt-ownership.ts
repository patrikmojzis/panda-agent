import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_CHANNEL_RECEIPT_OWNERSHIP} from "../../../integrations/postgres/schema-versions/0020-channel-receipt-ownership.js";

export const CHANNEL_RECEIPT_OWNERSHIP_MIGRATION: PostgresMigration = {
  ...PANDA_CHANNEL_RECEIPT_OWNERSHIP,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."outbound_deliveries" ADD COLUMN claim_token UUID;
      ALTER TABLE "runtime"."channel_actions" ADD COLUMN claim_token UUID;
    `);
  },
};
