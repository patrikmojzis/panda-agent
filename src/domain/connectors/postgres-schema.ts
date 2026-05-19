import {addConstraint, assertIntegrityChecks} from "../../lib/postgres-integrity.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {ensurePostgresAgentTableSchema} from "../agents/postgres-schema.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {ensurePostgresIdentitySchema} from "../identity/postgres-schema.js";
import {buildConnectorAccountTableNames} from "./postgres-shared.js";

export async function ensurePostgresConnectorAccountSchema(pool: PgQueryable): Promise<void> {
  const tables = buildConnectorAccountTableNames();
  const agentTableName = buildAgentTableNames().agents;
  const identityTableName = buildIdentityTableNames().identities;

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await ensurePostgresIdentitySchema(pool);
  await ensurePostgresAgentTableSchema(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.connectorAccounts} (
      id UUID PRIMARY KEY,
      source TEXT NOT NULL,
      account_key TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      owner_kind TEXT NOT NULL DEFAULT 'system',
      owner_identity_id TEXT,
      owner_agent_key TEXT,
      display_name TEXT,
      external_account_id TEXT,
      external_username TEXT,
      status TEXT NOT NULL DEFAULT 'enabled',
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.connectorAccountSecrets} (
      account_id UUID NOT NULL,
      secret_key TEXT NOT NULL,
      value_ciphertext BYTEA NOT NULL,
      value_iv BYTEA NOT NULL,
      value_tag BYTEA NOT NULL,
      key_version SMALLINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await assertIntegrityChecks(pool, "Connector account schema", [
    {
      label: "connector_accounts duplicate source/account_key",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM (
          SELECT COUNT(*)::INTEGER AS duplicate_count
          FROM ${tables.connectorAccounts}
          GROUP BY source, account_key
        ) AS duplicates
        WHERE duplicate_count > 1
      `,
    },
    {
      label: "connector_accounts duplicate source/connector_key",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM (
          SELECT COUNT(*)::INTEGER AS duplicate_count
          FROM ${tables.connectorAccounts}
          GROUP BY source, connector_key
        ) AS duplicates
        WHERE duplicate_count > 1
      `,
    },
    {
      label: "connector_account_secrets duplicate account/secret_key",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM (
          SELECT COUNT(*)::INTEGER AS duplicate_count
          FROM ${tables.connectorAccountSecrets}
          GROUP BY account_id, secret_key
        ) AS duplicates
        WHERE duplicate_count > 1
      `,
    },
    {
      label: "connector_accounts invalid owner_kind",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.connectorAccounts}
        WHERE owner_kind NOT IN ('system', 'identity', 'agent')
      `,
    },
    {
      label: "connector_accounts invalid status",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.connectorAccounts}
        WHERE status NOT IN ('enabled', 'disabled', 'revoked', 'error')
      `,
    },
    {
      label: "connector_accounts invalid owner fields",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.connectorAccounts}
        WHERE NOT (
          (owner_kind = 'system' AND owner_identity_id IS NULL AND owner_agent_key IS NULL)
          OR (owner_kind = 'identity' AND owner_identity_id IS NOT NULL AND owner_agent_key IS NULL)
          OR (owner_kind = 'agent' AND owner_agent_key IS NOT NULL AND owner_identity_id IS NULL)
        )
      `,
    },
    {
      label: "connector_accounts.owner_identity_id orphaned from identities.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.connectorAccounts} AS account
        LEFT JOIN ${identityTableName} AS identity
          ON identity.id = account.owner_identity_id
        WHERE account.owner_identity_id IS NOT NULL
          AND identity.id IS NULL
      `,
    },
    {
      label: "connector_accounts.owner_agent_key orphaned from agents.agent_key",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.connectorAccounts} AS account
        LEFT JOIN ${agentTableName} AS agent
          ON agent.agent_key = account.owner_agent_key
        WHERE account.owner_agent_key IS NOT NULL
          AND agent.agent_key IS NULL
      `,
    },
    {
      label: "connector_account_secrets.account_id orphaned from connector_accounts.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.connectorAccountSecrets} AS secret
        LEFT JOIN ${tables.connectorAccounts} AS account
          ON account.id = secret.account_id
        WHERE account.id IS NULL
      `,
    },
  ]);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_connector_accounts_source_account_key_idx`)}
    ON ${tables.connectorAccounts} (source, account_key)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_connector_accounts_source_connector_key_idx`)}
    ON ${tables.connectorAccounts} (source, connector_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_connector_accounts_source_status_idx`)}
    ON ${tables.connectorAccounts} (source, status, account_key)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_connector_account_secrets_key_idx`)}
    ON ${tables.connectorAccountSecrets} (account_id, secret_key)
  `);

  await addConstraint(pool, `
    ALTER TABLE ${tables.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_connector_accounts_owner_kind_check`)}
    CHECK (owner_kind IN ('system', 'identity', 'agent'))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_connector_accounts_status_check`)}
    CHECK (status IN ('enabled', 'disabled', 'revoked', 'error'))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_connector_accounts_owner_exclusive_check`)}
    CHECK (
      (owner_kind = 'system' AND owner_identity_id IS NULL AND owner_agent_key IS NULL)
      OR (owner_kind = 'identity' AND owner_identity_id IS NOT NULL AND owner_agent_key IS NULL)
      OR (owner_kind = 'agent' AND owner_agent_key IS NOT NULL AND owner_identity_id IS NULL)
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.connectorAccountSecrets}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_connector_account_secrets_key_check`)}
    CHECK (secret_key <> '')
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_connector_accounts_owner_identity_fk`)}
    FOREIGN KEY (owner_identity_id)
    REFERENCES ${identityTableName}(id)
    ON DELETE RESTRICT
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_connector_accounts_owner_agent_fk`)}
    FOREIGN KEY (owner_agent_key)
    REFERENCES ${agentTableName}(agent_key)
    ON DELETE RESTRICT
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.connectorAccountSecrets}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_connector_account_secrets_account_fk`)}
    FOREIGN KEY (account_id)
    REFERENCES ${tables.connectorAccounts}(id)
    ON DELETE CASCADE
  `);
}
