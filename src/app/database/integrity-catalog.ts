import type {IntegrityCheckGroup} from "../../lib/postgres-integrity.js";
import {runIntegrityChecksReadOnly} from "../../lib/postgres-integrity.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {assertPandaSchemaObjectManifest} from "./schema-object-catalog.js";

const PANDA_DATABASE_ROW_INTEGRITY_CHECKS: readonly IntegrityCheckGroup[] = [
  {
    scope: "Postgres constraints",
    checks: [{
      label: "unvalidated Panda constraints",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM pg_constraint AS constraint_record
        INNER JOIN pg_namespace AS namespace
          ON namespace.oid = constraint_record.connamespace
        WHERE namespace.nspname IN ('runtime', 'session')
          AND constraint_record.convalidated = FALSE
      `,
    }],
  },
  {
    scope: "Postgres indexes",
    checks: [{
      label: "invalid or unfinished Panda indexes",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM pg_index AS index_record
        INNER JOIN pg_class AS relation
          ON relation.oid = index_record.indrelid
        INNER JOIN pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('runtime', 'session')
          AND (index_record.indisvalid = FALSE OR index_record.indisready = FALSE)
      `,
    }],
  },
  {
    scope: "Control identity access",
    checks: [
      {
        label: "active Control grants owned by deleted identities",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM runtime.control_grants AS control_grant
          INNER JOIN runtime.identities AS identity
            ON identity.id = control_grant.identity_id
          WHERE identity.status = 'deleted'
            AND control_grant.active = TRUE
        `,
      },
      {
        label: "unrevoked Control sessions owned by deleted identities",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM runtime.control_sessions AS control_session
          INNER JOIN runtime.identities AS identity
            ON identity.id = control_session.identity_id
          WHERE identity.status = 'deleted'
            AND control_session.revoked_at IS NULL
        `,
      },
    ],
  },
];

export async function runPandaDatabaseIntegrityChecks(pool: PgPoolLike): Promise<{checked: number}> {
  await assertPandaSchemaObjectManifest(pool);
  const result = await runIntegrityChecksReadOnly(pool, PANDA_DATABASE_ROW_INTEGRITY_CHECKS);
  return {checked: result.checked + 3};
}
