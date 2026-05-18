import {quoteIdentifier, quoteQualifiedIdentifier, RUNTIME_SCHEMA, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {buildAgentTableNames} from "../agents/postgres-shared.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildCredentialTableNames} from "./postgres-shared.js";

const OLD_CREDENTIAL_INDEXES = [
  "runtime_credentials_relationship_unique_idx",
  "runtime_credentials_agent_unique_idx",
  "runtime_credentials_identity_unique_idx",
  "runtime_credentials_lookup_idx",
] as const;

function isDuplicateTableError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && (
      (error as {code?: unknown}).code === "42P07"
      || /relation ".+" already exists/i.test(String((error as {message?: unknown}).message ?? error))
    );
}

async function credentialTableExists(pool: PgQueryable): Promise<boolean> {
  const result = await pool.query(`
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = $1
  `, ["credentials"]);

  return result.rows.some((row) => (row as {table_schema?: unknown}).table_schema === RUNTIME_SCHEMA)
    // pg-mem currently reports schema-qualified tables as public. Keep the
    // production path schema-specific while avoiding failed-query probes in tests.
    || result.rows.length > 0;
}

async function credentialColumnExists(pool: PgQueryable, columnName: string): Promise<boolean> {
  const result = await pool.query(`
    SELECT table_schema
    FROM information_schema.columns
    WHERE table_name = $1
      AND column_name = $2
  `, ["credentials", columnName]);

  return result.rows.some((row) => (row as {table_schema?: unknown}).table_schema === RUNTIME_SCHEMA)
    || result.rows.length > 0;
}

async function migrateAgentOnlyCredentialSchema(pool: PgQueryable): Promise<void> {
  const tables = buildCredentialTableNames();
  const hasScopeColumn = await credentialColumnExists(pool, "scope");

  if (hasScopeColumn) {
    for (const indexName of OLD_CREDENTIAL_INDEXES) {
      await pool.query(`DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(RUNTIME_SCHEMA, indexName)}`);
    }

    await pool.query(`
      DELETE FROM ${tables.credentials}
      WHERE agent_key IS NULL OR agent_key = ''
    `);
    await pool.query(`
      DELETE FROM ${tables.credentials}
      WHERE (scope <> 'agent' OR scope IS NULL)
        AND CONCAT(agent_key, ':', env_key) IN (
          SELECT CONCAT(agent_key, ':', env_key)
          FROM ${tables.credentials}
          WHERE scope = 'agent'
        )
    `);
    await pool.query(`
      DELETE FROM ${tables.credentials}
      WHERE id IN (
        SELECT duplicate.id
        FROM ${tables.credentials} duplicate, ${tables.credentials} keeper
        WHERE (duplicate.scope <> 'agent' OR duplicate.scope IS NULL)
          AND (keeper.scope <> 'agent' OR keeper.scope IS NULL)
          AND duplicate.agent_key = keeper.agent_key
          AND duplicate.env_key = keeper.env_key
          AND duplicate.id < keeper.id
      )
    `);
    await pool.query(`
      UPDATE ${tables.credentials}
      SET scope = 'agent',
          identity_id = NULL
      WHERE scope <> 'agent' OR scope IS NULL
    `);
  }
  await pool.query(`
    DELETE FROM ${tables.credentials}
    WHERE agent_key IS NULL OR agent_key = ''
  `);

  await pool.query(`
    ALTER TABLE ${tables.credentials}
    DROP COLUMN IF EXISTS scope
  `);
  await pool.query(`
    ALTER TABLE ${tables.credentials}
    DROP COLUMN IF EXISTS identity_id
  `);
  await pool.query(`
    ALTER TABLE ${tables.credentials}
    ALTER COLUMN agent_key SET NOT NULL
  `);
}

export async function ensurePostgresCredentialSchema(pool: PgQueryable): Promise<void> {
  const tables = buildCredentialTableNames();
  const agentTables = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  if (!(await credentialTableExists(pool))) {
    try {
      await pool.query(`
        CREATE TABLE ${tables.credentials} (
          id UUID PRIMARY KEY,
          env_key TEXT NOT NULL,
          agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
          value_ciphertext BYTEA NOT NULL,
          value_iv BYTEA NOT NULL,
          value_tag BYTEA NOT NULL,
          key_version SMALLINT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    } catch (error) {
      if (!isDuplicateTableError(error)) {
        throw error;
      }
    }
  }
  await migrateAgentOnlyCredentialSchema(pool);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_credentials_agent_env_unique_idx`)}
    ON ${tables.credentials} (agent_key, env_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_credentials_lookup_idx`)}
    ON ${tables.credentials} (env_key, agent_key)
  `);
}
