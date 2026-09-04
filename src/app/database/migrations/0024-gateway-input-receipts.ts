import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_GATEWAY_INPUT_RECEIPTS} from "../../../integrations/postgres/schema-versions/0024-gateway-input-receipts.js";

export const GATEWAY_INPUT_RECEIPTS_MIGRATION: PostgresMigration = {
  ...PANDA_GATEWAY_INPUT_RECEIPTS,
  apply: async ({queryable}) => {
    // Event IDs are TEXT. A separate UUID avoids casting historical IDs or
    // inventing a delivery outcome for legacy rows in the ambiguity window.
    await queryable.query(`ALTER TABLE "runtime"."gateway_events" ADD COLUMN input_id UUID;`);
  },
};
