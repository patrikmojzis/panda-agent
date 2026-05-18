import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../../lib/postgres-relations.js";

import {addConstraint, assertIntegrityChecks} from "../../../lib/postgres-integrity.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import {buildIdentityTableNames} from "../../identity/postgres-shared.js";
import {buildSessionTableNames} from "../postgres-shared.js";
import {buildSessionRouteTableNames, type SessionRouteTableNames} from "./postgres-shared.js";

async function readSessionRouteColumnNames(pool: PgQueryable): Promise<Set<string>> {
  const result = await pool.query(`
    SELECT table_schema, column_name
    FROM information_schema.columns
    WHERE table_name = 'session_routes'
  `);
  const runtimeColumns = result.rows.filter((row) => {
    return String((row as {table_schema?: unknown}).table_schema ?? "") === "runtime";
  });
  const rows = runtimeColumns.length > 0
    ? runtimeColumns
    // pg-mem can report schema-qualified tables as public after hand-built
    // legacy setup. Production keeps the schema-specific path above.
    : result.rows;

  return new Set(rows.map((row) => String((row as {column_name?: unknown}).column_name ?? "")));
}

async function createSessionRoutesTable(
  pool: PgQueryable,
  tableName: string,
  options: {
    ifNotExists?: boolean;
  } = {},
): Promise<void> {
  const existenceClause = options.ifNotExists === false ? "" : " IF NOT EXISTS";
  await pool.query(`
    CREATE TABLE${existenceClause} ${tableName} (
      id BIGSERIAL PRIMARY KEY,
      session_id TEXT NOT NULL,
      identity_id TEXT,
      channel TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      external_actor_id TEXT,
      external_message_id TEXT,
      captured_at_ms BIGINT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function assertSessionRouteIntegrity(
  pool: PgQueryable,
  tables: SessionRouteTableNames,
  options: {
    trimIdentityId: boolean;
  },
): Promise<void> {
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;
  const identityReference = options.trimIdentityId
    ? "NULLIF(BTRIM(route.identity_id), '')"
    : "route.identity_id";

  await assertIntegrityChecks(pool, "Session route schema", [
    {
      label: "session_routes.session_id orphaned from agent_sessions.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.sessionRoutes} AS route
        LEFT JOIN ${sessionTableName} AS session
          ON session.id = route.session_id
        WHERE session.id IS NULL
      `,
    },
    {
      label: "session_routes.identity_id orphaned from identities.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.sessionRoutes} AS route
        LEFT JOIN ${identityTableName} AS identity
          ON identity.id = ${identityReference}
        WHERE ${identityReference} IS NOT NULL
          AND identity.id IS NULL
      `,
    },
  ]);
}

async function rebuildLegacySessionRoutesTable(
  pool: PgQueryable,
  tables: SessionRouteTableNames,
): Promise<void> {
  const replacementTable = `"runtime"."session_routes_rebuild"`;
  await pool.query(`DROP TABLE IF EXISTS ${replacementTable}`);
  await createSessionRoutesTable(pool, replacementTable, {ifNotExists: false});
  await pool.query(`
    INSERT INTO ${replacementTable} (
      session_id,
      identity_id,
      channel,
      connector_key,
      external_conversation_id,
      external_actor_id,
      external_message_id,
      captured_at_ms,
      metadata,
      created_at,
      updated_at
    )
    SELECT
      session_id,
      NULLIF(BTRIM(identity_id), ''),
      channel,
      connector_key,
      external_conversation_id,
      external_actor_id,
      external_message_id,
      captured_at_ms,
      metadata,
      created_at,
      updated_at
    FROM ${tables.sessionRoutes}
  `);
  await pool.query(`DROP TABLE ${tables.sessionRoutes}`);
  await pool.query(`ALTER TABLE ${replacementTable} RENAME TO session_routes`);
}

export async function ensurePostgresSessionRouteSchema(pool: PgQueryable): Promise<void> {
  const tables = buildSessionRouteTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  const existingColumns = await readSessionRouteColumnNames(pool);
  if (existingColumns.size === 0) {
    await createSessionRoutesTable(pool, tables.sessionRoutes);
  } else if (!existingColumns.has("id")) {
    await assertSessionRouteIntegrity(pool, tables, {trimIdentityId: true});
    await rebuildLegacySessionRoutesTable(pool, tables);
  } else {
    await createSessionRoutesTable(pool, tables.sessionRoutes);
  }
  await pool.query(`
    ALTER TABLE ${tables.sessionRoutes}
    ALTER COLUMN identity_id DROP NOT NULL
  `);
  await pool.query(`
    ALTER TABLE ${tables.sessionRoutes}
    ALTER COLUMN identity_id DROP DEFAULT
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_routes_lookup_idx`)}
    ON ${tables.sessionRoutes} (session_id, identity_id, captured_at_ms DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_routes_global_unique_idx`)}
    ON ${tables.sessionRoutes} (session_id, channel)
    WHERE identity_id IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_session_routes_identity_unique_idx`)}
    ON ${tables.sessionRoutes} (session_id, identity_id, channel)
    WHERE identity_id IS NOT NULL
  `);
  await assertSessionRouteIntegrity(pool, tables, {trimIdentityId: false});
  await addConstraint(pool, `
    ALTER TABLE ${tables.sessionRoutes}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_session_routes_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.sessionRoutes}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_session_routes_identity_fk`)}
    FOREIGN KEY (identity_id)
    REFERENCES ${identityTableName}(id)
    ON DELETE CASCADE
  `);
}
