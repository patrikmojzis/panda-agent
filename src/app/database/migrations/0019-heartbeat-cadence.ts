import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_HEARTBEAT_CADENCE} from "../../../integrations/postgres/schema-versions/0019-heartbeat-cadence.js";

export const HEARTBEAT_CADENCE_MIGRATION: PostgresMigration = {
  ...PANDA_HEARTBEAT_CADENCE,
  apply: async ({queryable}) => {
    await queryable.query(`
      ALTER TABLE "runtime"."session_heartbeats"
        ADD COLUMN config_revision INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN last_cadence_change_reason TEXT;
    `);
  },
};
