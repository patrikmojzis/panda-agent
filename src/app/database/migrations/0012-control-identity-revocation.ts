import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import {PANDA_CONTROL_IDENTITY_REVOCATION} from "../../../integrations/postgres/schema-versions/0012-control-identity-revocation.js";

/** Repairs Control access rows created before identity status became authoritative. */
export const CONTROL_IDENTITY_REVOCATION_MIGRATION: PostgresMigration = {
  ...PANDA_CONTROL_IDENTITY_REVOCATION,
  apply: async ({queryable}) => {
    await queryable.query(`
      UPDATE "runtime"."control_grants"
      SET "active" = FALSE,
          "updated_at" = NOW()
      WHERE "active" = TRUE
        AND "identity_id" IN (
          SELECT "id"
          FROM "runtime"."identities"
          WHERE "status" = 'deleted'
        )
    `);
    await queryable.query(`
      UPDATE "runtime"."control_sessions"
      SET "revoked_at" = NOW()
      WHERE "revoked_at" IS NULL
        AND "identity_id" IN (
          SELECT "id"
          FROM "runtime"."identities"
          WHERE "status" = 'deleted'
        )
    `);
  },
};
