import {quoteIdentifier, CREATE_RUNTIME_SCHEMA_SQL} from "../../lib/postgres-relations.js";

import {addConstraint, assertIntegrityChecks} from "../../lib/postgres-integrity.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildEmailTableNames} from "./postgres-shared.js";

export async function ensurePostgresEmailSchema(pool: PgQueryable): Promise<void> {
  const tables = buildEmailTableNames();
  const agentTableName = buildAgentTableNames().agents;
  const sessionTableName = buildSessionTableNames().sessions;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.emailAccounts} (
      id UUID PRIMARY KEY,
      agent_key TEXT NOT NULL,
      account_key TEXT NOT NULL,
      from_address TEXT NOT NULL,
      from_name TEXT,
      imap_config JSONB NOT NULL,
      smtp_config JSONB NOT NULL,
      mailboxes JSONB NOT NULL,
      sync_state JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.emailAllowedRecipients} (
      id UUID PRIMARY KEY,
      agent_key TEXT NOT NULL,
      account_key TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.emailRoutes} (
      id UUID PRIMARY KEY,
      agent_key TEXT NOT NULL,
      account_key TEXT NOT NULL,
      mailbox TEXT,
      session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.emailMessages} (
      id UUID PRIMARY KEY,
      agent_key TEXT NOT NULL,
      account_key TEXT NOT NULL,
      session_id TEXT,
      route_id UUID,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      mailbox TEXT,
      uid INTEGER CHECK (uid IS NULL OR uid >= 0),
      uid_validity TEXT,
      message_id_header TEXT,
      in_reply_to TEXT,
      references_header TEXT,
      thread_key TEXT NOT NULL,
      subject TEXT,
      from_name TEXT,
      from_address TEXT,
      reply_to_address TEXT,
      sent_at TIMESTAMPTZ,
      received_at TIMESTAMPTZ,
      body_text TEXT,
      body_excerpt TEXT,
      authentication_results TEXT,
      auth_spf TEXT CHECK (auth_spf IS NULL OR auth_spf IN ('pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'unknown')),
      auth_dkim TEXT CHECK (auth_dkim IS NULL OR auth_dkim IN ('pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'unknown')),
      auth_dmarc TEXT CHECK (auth_dmarc IS NULL OR auth_dmarc IN ('pass', 'fail', 'softfail', 'neutral', 'none', 'temperror', 'permerror', 'unknown')),
      auth_summary TEXT NOT NULL DEFAULT 'unknown' CHECK (auth_summary IN ('trusted', 'suspicious', 'unknown')),
      has_attachments BOOLEAN NOT NULL DEFAULT FALSE,
      source_delivery_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.emailMessageRecipients} (
      id UUID PRIMARY KEY,
      message_id UUID NOT NULL REFERENCES ${tables.emailMessages}(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('from', 'reply_to', 'to', 'cc')),
      address TEXT NOT NULL,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.emailAttachments} (
      id UUID PRIMARY KEY,
      message_id UUID NOT NULL REFERENCES ${tables.emailMessages}(id) ON DELETE CASCADE,
      filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
      local_path TEXT,
      content_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables.emailMessages}
    ADD COLUMN IF NOT EXISTS session_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables.emailMessages}
    ADD COLUMN IF NOT EXISTS route_id UUID
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_accounts_key_idx`)}
    ON ${tables.emailAccounts} (agent_key, account_key)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_allowed_key_idx`)}
    ON ${tables.emailAllowedRecipients} (agent_key, account_key, address)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_routes_account_idx`)}
    ON ${tables.emailRoutes} (agent_key, account_key)
    WHERE mailbox IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_routes_mailbox_idx`)}
    ON ${tables.emailRoutes} (agent_key, account_key, mailbox)
    WHERE mailbox IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_routes_session_idx`)}
    ON ${tables.emailRoutes} (session_id, agent_key, account_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_accounts_enabled_idx`)}
    ON ${tables.emailAccounts} (enabled, agent_key, account_key)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_messages_mailbox_uid_idx`)}
    ON ${tables.emailMessages} (agent_key, account_key, mailbox, uid_validity, uid)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_messages_thread_idx`)}
    ON ${tables.emailMessages} (agent_key, account_key, thread_key, COALESCE(received_at, sent_at, created_at))
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_messages_session_idx`)}
    ON ${tables.emailMessages} (session_id, agent_key, COALESCE(received_at, sent_at, created_at))
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_messages_route_idx`)}
    ON ${tables.emailMessages} (route_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_email_recipients_message_idx`)}
    ON ${tables.emailMessageRecipients} (message_id, role)
  `);
  await assertIntegrityChecks(pool, "Email schema", [
    {
      label: "email_routes.session_id orphaned from agent_sessions.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.emailRoutes} AS route
        LEFT JOIN ${sessionTableName} AS session
          ON session.id = route.session_id
        WHERE session.id IS NULL
      `,
    },
    {
      label: "email_messages.session_id orphaned from agent_sessions.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.emailMessages} AS message
        LEFT JOIN ${sessionTableName} AS session
          ON session.id = message.session_id
        WHERE message.session_id IS NOT NULL
          AND session.id IS NULL
      `,
    },
    {
      label: "email_accounts.agent_key orphaned from agents.agent_key",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables.emailAccounts} AS account
        LEFT JOIN ${agentTableName} AS agent
          ON agent.agent_key = account.agent_key
        WHERE agent.agent_key IS NULL
      `,
    },
  ]);
  await addConstraint(pool, `
    ALTER TABLE ${tables.emailAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_email_accounts_agent_fk`)}
    FOREIGN KEY (agent_key)
    REFERENCES ${agentTableName}(agent_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.emailAllowedRecipients}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_email_allowed_account_fk`)}
    FOREIGN KEY (agent_key, account_key)
    REFERENCES ${tables.emailAccounts}(agent_key, account_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.emailRoutes}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_email_routes_account_fk`)}
    FOREIGN KEY (agent_key, account_key)
    REFERENCES ${tables.emailAccounts}(agent_key, account_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.emailRoutes}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_email_routes_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.emailMessages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_email_messages_account_fk`)}
    FOREIGN KEY (agent_key, account_key)
    REFERENCES ${tables.emailAccounts}(agent_key, account_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.emailMessages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_email_messages_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables.emailMessages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables.prefix}_email_messages_route_fk`)}
    FOREIGN KEY (route_id)
    REFERENCES ${tables.emailRoutes}(id)
    ON DELETE SET NULL
  `);
}
