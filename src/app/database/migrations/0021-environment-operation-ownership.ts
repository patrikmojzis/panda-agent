import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_ENVIRONMENT_OPERATION_OWNERSHIP} from "../../../integrations/postgres/schema-versions/0021-environment-operation-ownership.js";

export const ENVIRONMENT_OPERATION_OWNERSHIP_MIGRATION: PostgresMigration = {
  ...PANDA_ENVIRONMENT_OPERATION_OWNERSHIP,
  apply: async ({queryable}) => {
    await queryable.query(`ALTER TABLE "runtime"."execution_environments" ADD COLUMN operation_id TEXT;`);
  },
};
