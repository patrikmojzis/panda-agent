import {addConstraint} from "../../../lib/postgres-integrity.js";
import type {PgPoolLike} from "../../../lib/postgres-query.js";
import {CREATE_RUNTIME_SCHEMA_SQL, postgresRelationExists, quoteIdentifier, buildRuntimeRelationNames} from "../../../lib/postgres-relations.js";
import {ensurePostgresConnectorAccountSchema} from "../../../domain/connectors/postgres-schema.js";
import {buildConnectorAccountTableNames} from "../../../domain/connectors/postgres-shared.js";
import {buildIdentityTableNames} from "../../../domain/identity/postgres-shared.js";
import {buildConversationSessionTableNames} from "../../../domain/sessions/conversations/postgres-shared.js";

const WHATSAPP_CONNECTOR_ACCOUNT_HARD_CUT = "connector_accounts_v1_2026_08_16";
const WHATSAPP_MIGRATION_LOCK = "__whatsapp_schema_lock__";

export interface WhatsAppAuthTableNames {
  prefix: string;
  authCreds: string;
  authKeys: string;
  runtimeStatus: string;
  migrations: string;
}

export function buildWhatsAppAuthTableNames(): WhatsAppAuthTableNames {
  return buildRuntimeRelationNames({
    authCreds: "whatsapp_account_auth_creds",
    authKeys: "whatsapp_account_auth_keys",
    runtimeStatus: "whatsapp_account_runtime_status",
    migrations: "whatsapp_migrations",
  });
}

async function applyWhatsAppConnectorAccountHardCut(pool: PgPoolLike): Promise<void> {
  const tables = buildWhatsAppAuthTableNames();
  const identities = buildIdentityTableNames();
  const conversations = buildConversationSessionTableNames();
  const connectors = buildConnectorAccountTableNames();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.migrations} (
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The permanent sentinel gives concurrent initializers a row to serialize on,
    // including the first run where the hard-cut marker does not exist yet.
    await client.query(`
      INSERT INTO ${tables.migrations} (migration_key)
      VALUES ($1)
      ON CONFLICT (migration_key) DO NOTHING
    `, [WHATSAPP_MIGRATION_LOCK]);
    await client.query(`
      SELECT migration_key
      FROM ${tables.migrations}
      WHERE migration_key = $1
      FOR UPDATE
    `, [WHATSAPP_MIGRATION_LOCK]);
    const applied = await client.query(`
      SELECT migration_key
      FROM ${tables.migrations}
      WHERE migration_key = $1
    `, [WHATSAPP_CONNECTOR_ACCOUNT_HARD_CUT]);
    if (applied.rows.length > 0) {
      await client.query("COMMIT");
      return;
    }

    // Intentional hard cut: old connector-key auth cannot identify an owned account.
    await client.query(`DROP TABLE IF EXISTS "runtime"."whatsapp_auth_keys"`);
    await client.query(`DROP TABLE IF EXISTS "runtime"."whatsapp_auth_creds"`);
    if (await postgresRelationExists(client, "runtime", "identity_bindings")) {
      await client.query(`DELETE FROM ${identities.identityBindings} WHERE source = 'whatsapp'`);
    }
    if (await postgresRelationExists(client, "runtime", "conversation_sessions")) {
      await client.query(`DELETE FROM ${conversations.conversationSessions} WHERE source = 'whatsapp'`);
    }
    await client.query(`DELETE FROM ${connectors.connectorAccounts} WHERE source = 'whatsapp'`);
    await client.query(`
      INSERT INTO ${tables.migrations} (migration_key)
      VALUES ($1)
    `, [WHATSAPP_CONNECTOR_ACCOUNT_HARD_CUT]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function ensurePostgresWhatsAppAuthSchema(pool: PgPoolLike): Promise<void> {
  const tables = buildWhatsAppAuthTableNames();
  const connectors = buildConnectorAccountTableNames();

  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await ensurePostgresConnectorAccountSchema(pool);
  await applyWhatsAppConnectorAccountHardCut(pool);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.authCreds} (
      account_id UUID PRIMARY KEY,
      value_ciphertext BYTEA NOT NULL,
      value_iv BYTEA NOT NULL,
      value_tag BYTEA NOT NULL,
      key_version SMALLINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.authKeys} (
      account_id UUID NOT NULL,
      category TEXT NOT NULL,
      key_id TEXT NOT NULL,
      value_ciphertext BYTEA NOT NULL,
      value_iv BYTEA NOT NULL,
      value_tag BYTEA NOT NULL,
      key_version SMALLINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (account_id, category, key_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.runtimeStatus} (
      account_id UUID PRIMARY KEY,
      socket_state TEXT NOT NULL,
      last_error TEXT,
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_whatsapp_account_auth_keys_updated_idx`)}
    ON ${tables.authKeys} (updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_whatsapp_account_runtime_heartbeat_idx`)}
    ON ${tables.runtimeStatus} (heartbeat_at DESC)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.authCreds}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_whatsapp_account_auth_creds_account_fk`)}
    FOREIGN KEY (account_id) REFERENCES ${connectors.connectorAccounts}(id) ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.authKeys}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_whatsapp_account_auth_keys_account_fk`)}
    FOREIGN KEY (account_id) REFERENCES ${connectors.connectorAccounts}(id) ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runtimeStatus}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_whatsapp_account_runtime_account_fk`)}
    FOREIGN KEY (account_id) REFERENCES ${connectors.connectorAccounts}(id) ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.runtimeStatus}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_whatsapp_account_runtime_state_check`)}
    CHECK (socket_state IN ('idle', 'connecting', 'open', 'reconnecting', 'closed', 'stopped', 'error'))
  `);
}
