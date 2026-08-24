// @ts-nocheck -- immutable esbuild output vendors already typechecked migration sources.

// src/lib/postgres-relations.ts
var RUNTIME_SCHEMA = "runtime";
var SESSION_SCHEMA = "session";
var CREATE_RUNTIME_SCHEMA_SQL = `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(RUNTIME_SCHEMA)};`;
function validateIdentifier(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new Error(`Invalid SQL identifier ${value}`);
  }
  return value;
}
function quoteIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}
function quoteQualifiedIdentifier(schema, relation) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(relation)}`;
}
async function postgresRelationExists(queryable, schemaName, relationName) {
  const safeSchema = validateIdentifier(schemaName);
  const safeRelation = validateIdentifier(relationName);
  const informationSchemaResult = await queryable.query(`
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = $1
  `, [safeRelation]);
  if (informationSchemaResult.rows.some((row) => row.table_schema === safeSchema)) {
    return true;
  }
  const publicFallbackExists = informationSchemaResult.rows.some((row) => row.table_schema === "public");
  try {
    const regclassResult = await queryable.query("SELECT to_regclass($1) AS relation", [
      `${safeSchema}.${safeRelation}`
    ]);
    return regclassResult.rows.some((row) => row.relation != null);
  } catch {
    return publicFallbackExists;
  }
}
function buildSchemaRelationNames(schema, relationSuffixes) {
  const safeSchema = validateIdentifier(schema);
  const relationNames = Object.fromEntries(
    Object.entries(relationSuffixes).map(([name, suffix]) => {
      return [name, quoteQualifiedIdentifier(safeSchema, suffix)];
    })
  );
  return {
    prefix: safeSchema,
    ...relationNames
  };
}
function buildRuntimeRelationNames(relationSuffixes) {
  return buildSchemaRelationNames(RUNTIME_SCHEMA, relationSuffixes);
}
function buildSessionRelationNames(relationSuffixes) {
  return buildSchemaRelationNames(SESSION_SCHEMA, relationSuffixes);
}

// src/lib/postgres-errors.ts
function isDuplicateObjectError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? String(error.code ?? "") : "";
  if (code === "42710" || code === "42P07") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("already exists");
}

// src/lib/postgres-integrity.ts
function parseCount(row) {
  if (!row || typeof row !== "object") {
    return 0;
  }
  const value = row.count;
  return typeof value === "number" ? value : Number(value ?? 0);
}
async function assertIntegrityChecks(queryable, scope, checks) {
  for (const check of checks) {
    const result = await queryable.query(check.sql, [...check.values ?? []]);
    const count = parseCount(result.rows[0]);
    if (count > 0) {
      throw new Error(`${scope} integrity preflight failed: ${check.label} (${count} row${count === 1 ? "" : "s"}).`);
    }
  }
}
async function addConstraint(queryable, sql) {
  if (await namedConstraintExists(queryable, sql)) {
    return;
  }
  try {
    await queryable.query(sql);
  } catch (error) {
    if (isPgMemError(error) && isDuplicateObjectError(error)) return;
    throw error;
  }
}
async function alterIfSupported(queryable, sql) {
  if (await namedConstraintExists(queryable, sql)) {
    return true;
  }
  try {
    await queryable.query(sql);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unexpected kw_deferrable token") || message.includes("Unexpected lparen token") || message.includes('type "trigger" does not exist') || message.includes('Unkonwn language "plpgsql"') || message.includes("Not supported") && message.includes("pg-mem")) {
      return false;
    }
    if (isPgMemError(error) && isDuplicateObjectError(error)) return true;
    throw error;
  }
}
function isPgMemError(error) {
  return error instanceof Error && (error.stack?.includes("node_modules/pg-mem") === true || error.message.includes("🐜"));
}
function unquoteIdentifier(value) {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value;
}
function parseNamedConstraint(sql) {
  const match = /^\s*ALTER\s+TABLE\s+((?:"[^"]+"\.)?"[^"]+"|[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s+ADD\s+CONSTRAINT\s+"([^"]+)"/i.exec(sql);
  if (!match?.[1] || !match[2]) return null;
  const relationParts = match[1].split(".").map(unquoteIdentifier);
  const table = relationParts.at(-1);
  if (!table) return null;
  return {
    schema: relationParts.length > 1 ? relationParts[0] ?? null : null,
    table,
    name: match[2]
  };
}
async function namedConstraintExists(queryable, sql) {
  const constraint = parseNamedConstraint(sql);
  if (constraint === null) {
    return false;
  }
  const values = constraint.schema ? [constraint.name, constraint.table, constraint.schema] : [constraint.name, constraint.table];
  const result = await queryable.query(`
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_name = $1
      AND table_name = $2
      ${constraint.schema ? "AND table_schema = $3" : ""}
    LIMIT 1
  `, values);
  return result.rows.length > 0;
}

// src/domain/sessions/postgres-shared.ts
function buildSessionTableNames() {
  return buildRuntimeRelationNames({
    sessions: "agent_sessions",
    sessionHeartbeats: "session_heartbeats",
    sessionPrompts: "session_prompts",
    sessionTodos: "session_todos",
    sessionRuntimeConfig: "session_runtime_config"
  });
}

// src/domain/a2a/postgres-shared.ts
function buildA2ATableNames() {
  return {
    prefix: "a2a",
    a2aSessionBindings: `"runtime"."a2a_session_bindings"`
  };
}

// src/domain/a2a/postgres-schema.ts
function buildA2AIntegrityChecks() {
  const tables3 = buildA2ATableNames();
  const sessionTableName = buildSessionTableNames().sessions;
  return {
    scope: "A2A binding schema",
    checks: [
      {
        label: "a2a_session_bindings.sender_session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.a2aSessionBindings} AS binding
          LEFT JOIN ${sessionTableName} AS sender
            ON sender.id = binding.sender_session_id
          WHERE sender.id IS NULL
        `
      },
      {
        label: "a2a_session_bindings.recipient_session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.a2aSessionBindings} AS binding
          LEFT JOIN ${sessionTableName} AS recipient
            ON recipient.id = binding.recipient_session_id
          WHERE recipient.id IS NULL
        `
      }
    ]
  };
}
async function ensurePostgresA2ASessionBindingSchema(pool) {
  const tables3 = buildA2ATableNames();
  const sessionTableName = buildSessionTableNames().sessions;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.a2aSessionBindings} (
      sender_session_id TEXT NOT NULL,
      recipient_session_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (sender_session_id, recipient_session_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_bindings_sender_idx`)}
    ON ${tables3.a2aSessionBindings} (sender_session_id, updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_bindings_recipient_idx`)}
    ON ${tables3.a2aSessionBindings} (recipient_session_id, updated_at DESC)
  `);
  const integrity = buildA2AIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.a2aSessionBindings}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_session_bindings_sender_session_fk`)}
    FOREIGN KEY (sender_session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.a2aSessionBindings}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_session_bindings_recipient_session_fk`)}
    FOREIGN KEY (recipient_session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
}

// src/domain/identity/postgres-shared.ts
function buildIdentityTableNames() {
  return buildRuntimeRelationNames({
    identities: "identities",
    identityBindings: "identity_bindings"
  });
}

// src/domain/agents/postgres-shared.ts
function buildAgentTableNames() {
  return buildRuntimeRelationNames({
    agents: "agents",
    agentSkills: "agent_skills",
    agentPrompts: "agent_prompts",
    agentPairings: "agent_pairings"
  });
}

// src/domain/agents/postgres-schema.ts
async function ensurePostgresAgentTableSchema(pool) {
  const tables3 = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.agents} (
      agent_key TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
async function ensurePostgresAgentSchema(pool) {
  const tables3 = buildAgentTableNames();
  const identityTables = buildIdentityTableNames();
  await ensurePostgresAgentTableSchema(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.agentPairings} (
      agent_key TEXT NOT NULL REFERENCES ${tables3.agents}(agent_key) ON DELETE CASCADE,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_key, identity_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_agent_pairings_identity_idx`)}
    ON ${tables3.agentPairings} (identity_id, agent_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_agent_pairings_agent_created_idx`)}
    ON ${tables3.agentPairings} (agent_key, created_at, identity_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.agentSkills} (
      agent_key TEXT NOT NULL REFERENCES ${tables3.agents}(agent_key) ON DELETE CASCADE,
      skill_key TEXT NOT NULL,
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT[] NOT NULL DEFAULT '{}',
      agent_editable BOOLEAN NOT NULL DEFAULT TRUE,
      last_loaded_at TIMESTAMPTZ,
      load_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_key, skill_key)
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.agentSkills}
    ADD COLUMN IF NOT EXISTS last_loaded_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE ${tables3.agentSkills}
    ADD COLUMN IF NOT EXISTS load_count INTEGER NOT NULL DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE ${tables3.agentSkills}
    ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}'
  `);
  await pool.query(`
    ALTER TABLE ${tables3.agentSkills}
    ADD COLUMN IF NOT EXISTS agent_editable BOOLEAN NOT NULL DEFAULT TRUE
  `);
}

// src/domain/agents/telegram-stickers/postgres-shared.ts
function buildTelegramStickerTableNames() {
  return buildRuntimeRelationNames({
    stickers: "agent_telegram_stickers"
  });
}

// src/domain/agents/telegram-stickers/postgres-schema.ts
async function ensurePostgresTelegramStickerSchema(pool) {
  await ensurePostgresAgentTableSchema(pool);
  const agents = buildAgentTableNames();
  const tables3 = buildTelegramStickerTableNames();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.stickers} (
      id UUID PRIMARY KEY,
      agent_key TEXT NOT NULL REFERENCES ${agents.agents}(agent_key) ON DELETE CASCADE,
      connector_key TEXT NOT NULL,
      file_id TEXT NOT NULL,
      file_unique_id TEXT NOT NULL,
      set_name TEXT,
      set_title TEXT,
      emoji TEXT,
      sticker_type TEXT NOT NULL,
      sticker_format TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      size_bytes BIGINT,
      tags TEXT[] NOT NULL DEFAULT '{}',
      description TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (agent_key, connector_key, file_unique_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier("runtime_agent_telegram_stickers_agent_idx")}
    ON ${tables3.stickers} (agent_key, updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier("runtime_agent_telegram_stickers_tags_idx")}
    ON ${tables3.stickers} USING GIN (tags)
  `);
}

// src/domain/apps/auth-shared.ts
function buildAgentAppAuthTableNames() {
  return buildRuntimeRelationNames({
    launchTokens: "app_launch_tokens",
    sessions: "app_sessions"
  });
}

// src/domain/apps/auth-schema.ts
async function ensurePostgresAgentAppAuthSchema(pool) {
  const tables3 = buildAgentAppAuthTableNames();
  const agentTables = buildAgentTableNames();
  const identityTables = buildIdentityTableNames();
  const sessionTables = buildSessionTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.launchTokens} (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      app_slug TEXT NOT NULL,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_app_launch_tokens_lookup_idx`)}
    ON ${tables3.launchTokens} (agent_key, app_slug, identity_id, expires_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.sessions} (
      id TEXT PRIMARY KEY,
      session_token_hash TEXT NOT NULL UNIQUE,
      csrf_token_hash TEXT NOT NULL,
      agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      app_slug TEXT NOT NULL,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_app_sessions_lookup_idx`)}
    ON ${tables3.sessions} (agent_key, app_slug, identity_id, expires_at DESC)
    WHERE revoked_at IS NULL
  `);
}

// src/domain/channels/actions/postgres-shared.ts
function buildChannelActionTableNames() {
  return buildRuntimeRelationNames({
    channelActions: "channel_actions"
  });
}

// src/domain/channels/actions/postgres-schema.ts
async function ensurePostgresChannelActionSchema(pool) {
  const tables3 = buildChannelActionTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.channelActions} (
      id UUID PRIMARY KEY,
      channel TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_channel_actions_pending_idx`)}
    ON ${tables3.channelActions} (channel, connector_key, status, created_at, id)
  `);
}

// src/domain/channels/cursors/postgres-shared.ts
function buildChannelCursorTableNames() {
  return buildRuntimeRelationNames({
    channelCursors: "channel_cursors"
  });
}

// src/domain/channels/cursors/postgres-schema.ts
async function ensurePostgresChannelCursorSchema(pool) {
  const tables3 = buildChannelCursorTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.channelCursors} (
      source TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      cursor_key TEXT NOT NULL,
      cursor_value TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, connector_key, cursor_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_channel_cursors_updated_idx`)}
    ON ${tables3.channelCursors} (updated_at DESC)
  `);
}

// src/domain/threads/runtime/postgres-shared.ts
function buildThreadRuntimeTableNames() {
  return buildRuntimeRelationNames({
    threads: "threads",
    messages: "messages",
    inputs: "inputs",
    runs: "runs",
    toolJobs: "tool_jobs",
    bashJobs: "bash_jobs",
    shellStates: "shell_states"
  });
}

// src/domain/channels/deliveries/postgres-shared.ts
function buildOutboundDeliveryTableNames() {
  return buildRuntimeRelationNames({
    outboundDeliveries: "outbound_deliveries"
  });
}

// src/domain/channels/deliveries/postgres-schema.ts
function buildOutboundDeliveryIntegrityChecks() {
  const tables3 = buildOutboundDeliveryTableNames();
  const threadTableName = buildThreadRuntimeTableNames().threads;
  return {
    scope: "Outbound delivery schema",
    checks: [{
      label: "outbound_deliveries.thread_id orphaned from threads.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.outboundDeliveries} AS delivery
        LEFT JOIN ${threadTableName} AS thread
          ON thread.id = delivery.thread_id
        WHERE delivery.thread_id IS NOT NULL
          AND thread.id IS NULL
      `
    }]
  };
}
async function ensurePostgresOutboundDeliverySchema(pool) {
  const tables3 = buildOutboundDeliveryTableNames();
  const threadTableName = buildThreadRuntimeTableNames().threads;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.outboundDeliveries} (
      id UUID PRIMARY KEY,
      idempotency_key TEXT,
      thread_id TEXT,
      channel TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      external_actor_id TEXT,
      reply_to_message_id TEXT,
      items JSONB NOT NULL,
      metadata JSONB,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      sent_items JSONB,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.outboundDeliveries}
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_outbound_deliveries_idempotency_idx`)}
    ON ${tables3.outboundDeliveries} (idempotency_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_outbound_deliveries_pending_idx`)}
    ON ${tables3.outboundDeliveries} (channel, connector_key, status, created_at, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_outbound_deliveries_thread_idx`)}
    ON ${tables3.outboundDeliveries} (thread_id, created_at DESC)
  `);
  const integrity = buildOutboundDeliveryIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.outboundDeliveries}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_outbound_deliveries_thread_fk`)}
    FOREIGN KEY (thread_id)
    REFERENCES ${threadTableName}(id)
    ON DELETE SET NULL
  `);
}

// src/domain/connector-leases/postgres-schema.ts
var POSTGRES_CONNECTOR_LEASE_TABLE = `"runtime"."connector_leases"`;
async function ensurePostgresConnectorLeaseSchema(pool) {
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${POSTGRES_CONNECTOR_LEASE_TABLE} (
      source TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      holder_id TEXT NOT NULL,
      leased_until TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, connector_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier("runtime_connector_leases_expiry_idx")}
    ON ${POSTGRES_CONNECTOR_LEASE_TABLE} (leased_until)
  `);
}

// src/domain/identity/postgres-schema.ts
async function ensurePostgresIdentitySchema(pool) {
  const tables3 = buildIdentityTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.identities} (
      id TEXT PRIMARY KEY,
      handle TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.identityBindings} (
      id UUID PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES ${tables3.identities}(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      external_actor_id TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_identity_bindings_lookup_idx`)}
    ON ${tables3.identityBindings} (source, connector_key, external_actor_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_identity_bindings_identity_created_idx`)}
    ON ${tables3.identityBindings} (identity_id, created_at, id)
  `);
}

// src/domain/connectors/postgres-shared.ts
function buildConnectorAccountTableNames() {
  return buildRuntimeRelationNames({
    connectorAccounts: "connector_accounts",
    connectorAccountSecrets: "connector_account_secrets"
  });
}

// src/domain/connectors/postgres-schema.ts
function buildConnectorAccountIntegrityChecks() {
  const tables3 = buildConnectorAccountTableNames();
  const agentTableName = buildAgentTableNames().agents;
  const identityTableName = buildIdentityTableNames().identities;
  return {
    scope: "Connector account schema",
    checks: [
      {
        label: "connector_accounts duplicate source/account_key",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM (
            SELECT COUNT(*)::INTEGER AS duplicate_count
            FROM ${tables3.connectorAccounts}
            GROUP BY source, account_key
          ) AS duplicates
          WHERE duplicate_count > 1
        `
      },
      {
        label: "connector_accounts duplicate source/connector_key",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM (
            SELECT COUNT(*)::INTEGER AS duplicate_count
            FROM ${tables3.connectorAccounts}
            GROUP BY source, connector_key
          ) AS duplicates
          WHERE duplicate_count > 1
        `
      },
      {
        label: "connector_account_secrets duplicate account/secret_key",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM (
            SELECT COUNT(*)::INTEGER AS duplicate_count
            FROM ${tables3.connectorAccountSecrets}
            GROUP BY account_id, secret_key
          ) AS duplicates
          WHERE duplicate_count > 1
        `
      },
      {
        label: "connector_accounts invalid owner_kind",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.connectorAccounts}
          WHERE owner_kind NOT IN ('system', 'identity', 'agent')
        `
      },
      {
        label: "connector_accounts invalid status",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.connectorAccounts}
          WHERE status NOT IN ('enabled', 'disabled', 'revoked', 'error')
        `
      },
      {
        label: "connector_accounts invalid owner fields",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.connectorAccounts}
          WHERE NOT (
            (owner_kind = 'system' AND owner_identity_id IS NULL AND owner_agent_key IS NULL)
            OR (owner_kind = 'identity' AND owner_identity_id IS NOT NULL AND owner_agent_key IS NULL)
            OR (owner_kind = 'agent' AND owner_agent_key IS NOT NULL AND owner_identity_id IS NULL)
          )
        `
      },
      {
        label: "connector_accounts.owner_identity_id orphaned from identities.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.connectorAccounts} AS account
          LEFT JOIN ${identityTableName} AS identity
            ON identity.id = account.owner_identity_id
          WHERE account.owner_identity_id IS NOT NULL
            AND identity.id IS NULL
        `
      },
      {
        label: "connector_accounts.owner_agent_key orphaned from agents.agent_key",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.connectorAccounts} AS account
          LEFT JOIN ${agentTableName} AS agent
            ON agent.agent_key = account.owner_agent_key
          WHERE account.owner_agent_key IS NOT NULL
            AND agent.agent_key IS NULL
        `
      },
      {
        label: "connector_account_secrets.account_id orphaned from connector_accounts.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.connectorAccountSecrets} AS secret
          LEFT JOIN ${tables3.connectorAccounts} AS account
            ON account.id = secret.account_id
          WHERE account.id IS NULL
        `
      }
    ]
  };
}
async function ensurePostgresConnectorAccountSchema(pool) {
  const tables3 = buildConnectorAccountTableNames();
  const agentTableName = buildAgentTableNames().agents;
  const identityTableName = buildIdentityTableNames().identities;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await ensurePostgresIdentitySchema(pool);
  await ensurePostgresAgentTableSchema(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.connectorAccounts} (
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
    CREATE TABLE IF NOT EXISTS ${tables3.connectorAccountSecrets} (
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
  const integrity = buildConnectorAccountIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_connector_accounts_source_account_key_idx`)}
    ON ${tables3.connectorAccounts} (source, account_key)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_connector_accounts_source_connector_key_idx`)}
    ON ${tables3.connectorAccounts} (source, connector_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_connector_accounts_source_status_idx`)}
    ON ${tables3.connectorAccounts} (source, status, account_key)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_connector_account_secrets_key_idx`)}
    ON ${tables3.connectorAccountSecrets} (account_id, secret_key)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_connector_accounts_owner_kind_check`)}
    CHECK (owner_kind IN ('system', 'identity', 'agent'))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_connector_accounts_status_check`)}
    CHECK (status IN ('enabled', 'disabled', 'revoked', 'error'))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_connector_accounts_owner_exclusive_check`)}
    CHECK (
      (owner_kind = 'system' AND owner_identity_id IS NULL AND owner_agent_key IS NULL)
      OR (owner_kind = 'identity' AND owner_identity_id IS NOT NULL AND owner_agent_key IS NULL)
      OR (owner_kind = 'agent' AND owner_agent_key IS NOT NULL AND owner_identity_id IS NULL)
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.connectorAccountSecrets}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_connector_account_secrets_key_check`)}
    CHECK (secret_key <> '')
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_connector_accounts_owner_identity_fk`)}
    FOREIGN KEY (owner_identity_id)
    REFERENCES ${identityTableName}(id)
    ON DELETE RESTRICT
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.connectorAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_connector_accounts_owner_agent_fk`)}
    FOREIGN KEY (owner_agent_key)
    REFERENCES ${agentTableName}(agent_key)
    ON DELETE RESTRICT
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.connectorAccountSecrets}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_connector_account_secrets_account_fk`)}
    FOREIGN KEY (account_id)
    REFERENCES ${tables3.connectorAccounts}(id)
    ON DELETE CASCADE
  `);
}

// src/domain/control/postgres-shared.ts
function buildControlTableNames() {
  return buildRuntimeRelationNames({
    grants: "control_grants",
    sessions: "control_sessions",
    auditEvents: "control_audit_events"
  });
}

// src/domain/control/postgres-schema.ts
async function ensurePostgresControlSchema(pool) {
  const tables3 = buildControlTableNames();
  const identityTables = buildIdentityTableNames();
  const agentTables = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.grants} (
      id UUID PRIMARY KEY,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'scoped')),
      agent_key TEXT REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      label TEXT,
      login_token_hash TEXT NOT NULL UNIQUE,
      login_token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),
      login_token_consumed_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK ((role = 'admin' AND agent_key IS NULL) OR (role = 'scoped' AND agent_key IS NOT NULL))
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.grants}
    ADD COLUMN IF NOT EXISTS login_token_expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes')
  `);
  await pool.query(`
    ALTER TABLE ${tables3.grants}
    ADD COLUMN IF NOT EXISTS login_token_consumed_at TIMESTAMPTZ
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_control_grants_identity_idx`)}
    ON ${tables3.grants} (identity_id, active)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.sessions} (
      id UUID PRIMARY KEY,
      session_token_hash TEXT NOT NULL UNIQUE,
      csrf_token_hash TEXT NOT NULL,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('admin', 'scoped')),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_control_sessions_identity_idx`)}
    ON ${tables3.sessions} (identity_id, revoked_at, expires_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.auditEvents} (
      id UUID PRIMARY KEY,
      identity_id TEXT,
      session_id UUID,
      event_type TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// src/domain/credentials/postgres-shared.ts
function buildCredentialTableNames() {
  return buildRuntimeRelationNames({
    credentials: "credentials"
  });
}

// src/domain/credentials/postgres-schema.ts
var OLD_CREDENTIAL_INDEXES = [
  "runtime_credentials_relationship_unique_idx",
  "runtime_credentials_agent_unique_idx",
  "runtime_credentials_identity_unique_idx",
  "runtime_credentials_lookup_idx"
];
function buildCredentialIntegrityChecks() {
  const tables3 = buildCredentialTableNames();
  const agentTables = buildAgentTableNames();
  return {
    scope: "Credential schema",
    checks: [{
      label: "credentials.agent_key orphaned from agents.agent_key",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.credentials} AS credential
        LEFT JOIN ${agentTables.agents} AS agent ON agent.agent_key = credential.agent_key
        WHERE agent.agent_key IS NULL
      `
    }]
  };
}
async function credentialTableExists(pool) {
  const result = await pool.query(`
    SELECT table_schema
    FROM information_schema.tables
    WHERE table_name = $1
  `, ["credentials"]);
  return result.rows.some((row) => row.table_schema === RUNTIME_SCHEMA) || result.rows.length > 0;
}
async function credentialColumnExists(pool, columnName) {
  const result = await pool.query(`
    SELECT table_schema
    FROM information_schema.columns
    WHERE table_name = $1
      AND column_name = $2
  `, ["credentials", columnName]);
  return result.rows.some((row) => row.table_schema === RUNTIME_SCHEMA) || result.rows.length > 0;
}
async function migrateAgentOnlyCredentialSchema(pool) {
  const tables3 = buildCredentialTableNames();
  const hasScopeColumn = await credentialColumnExists(pool, "scope");
  if (hasScopeColumn) {
    for (const indexName of OLD_CREDENTIAL_INDEXES) {
      await pool.query(`DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(RUNTIME_SCHEMA, indexName)}`);
    }
    await pool.query(`
      DELETE FROM ${tables3.credentials}
      WHERE agent_key IS NULL OR agent_key = ''
    `);
    await pool.query(`
      DELETE FROM ${tables3.credentials}
      WHERE (scope <> 'agent' OR scope IS NULL)
        AND CONCAT(agent_key, ':', env_key) IN (
          SELECT CONCAT(agent_key, ':', env_key)
          FROM ${tables3.credentials}
          WHERE scope = 'agent'
        )
    `);
    await pool.query(`
      DELETE FROM ${tables3.credentials}
      WHERE id IN (
        SELECT duplicate.id
        FROM ${tables3.credentials} duplicate, ${tables3.credentials} keeper
        WHERE (duplicate.scope <> 'agent' OR duplicate.scope IS NULL)
          AND (keeper.scope <> 'agent' OR keeper.scope IS NULL)
          AND duplicate.agent_key = keeper.agent_key
          AND duplicate.env_key = keeper.env_key
          AND duplicate.id < keeper.id
      )
    `);
    await pool.query(`
      UPDATE ${tables3.credentials}
      SET scope = 'agent',
          identity_id = NULL
      WHERE scope <> 'agent' OR scope IS NULL
    `);
  }
  await pool.query(`
    DELETE FROM ${tables3.credentials}
    WHERE agent_key IS NULL OR agent_key = ''
  `);
  await pool.query(`
    ALTER TABLE ${tables3.credentials}
    DROP COLUMN IF EXISTS scope
  `);
  await pool.query(`
    ALTER TABLE ${tables3.credentials}
    DROP COLUMN IF EXISTS identity_id
  `);
  await pool.query(`
    ALTER TABLE ${tables3.credentials}
    ALTER COLUMN agent_key SET NOT NULL
  `);
}
async function ensurePostgresCredentialSchema(pool) {
  const tables3 = buildCredentialTableNames();
  const agentTables = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  if (!await credentialTableExists(pool)) {
    await pool.query(`
      CREATE TABLE ${tables3.credentials} (
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
  }
  await migrateAgentOnlyCredentialSchema(pool);
  const integrity = buildCredentialIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.credentials}
    ADD CONSTRAINT ${quoteIdentifier("credentials_agent_key_fkey")}
    FOREIGN KEY (agent_key) REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_credentials_agent_env_unique_idx`)}
    ON ${tables3.credentials} (agent_key, env_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_credentials_lookup_idx`)}
    ON ${tables3.credentials} (env_key, agent_key)
  `);
}

// src/domain/email/postgres-shared.ts
function buildEmailTableNames() {
  return buildRuntimeRelationNames({
    emailAccounts: "email_accounts",
    emailAllowedRecipients: "email_allowed_recipients",
    emailRoutes: "email_routes",
    emailMessages: "email_messages",
    emailMessageRecipients: "email_message_recipients",
    emailAttachments: "email_attachments"
  });
}

// src/domain/email/postgres-schema.ts
function buildEmailIntegrityChecks() {
  const tables3 = buildEmailTableNames();
  const agentTableName = buildAgentTableNames().agents;
  const sessionTableName = buildSessionTableNames().sessions;
  return {
    scope: "Email schema",
    checks: [
      {
        label: "email_routes.session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.emailRoutes} AS route
          LEFT JOIN ${sessionTableName} AS session
            ON session.id = route.session_id
          WHERE session.id IS NULL
        `
      },
      {
        label: "email_messages.session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.emailMessages} AS message
          LEFT JOIN ${sessionTableName} AS session
            ON session.id = message.session_id
          WHERE message.session_id IS NOT NULL
            AND session.id IS NULL
        `
      },
      {
        label: "email_accounts.agent_key orphaned from agents.agent_key",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.emailAccounts} AS account
          LEFT JOIN ${agentTableName} AS agent
            ON agent.agent_key = account.agent_key
          WHERE agent.agent_key IS NULL
        `
      }
    ]
  };
}
async function ensurePostgresEmailSchema(pool) {
  const tables3 = buildEmailTableNames();
  const agentTableName = buildAgentTableNames().agents;
  const sessionTableName = buildSessionTableNames().sessions;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.emailAccounts} (
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
    CREATE TABLE IF NOT EXISTS ${tables3.emailAllowedRecipients} (
      id UUID PRIMARY KEY,
      agent_key TEXT NOT NULL,
      account_key TEXT NOT NULL,
      address TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.emailRoutes} (
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
    CREATE TABLE IF NOT EXISTS ${tables3.emailMessages} (
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
    CREATE TABLE IF NOT EXISTS ${tables3.emailMessageRecipients} (
      id UUID PRIMARY KEY,
      message_id UUID NOT NULL REFERENCES ${tables3.emailMessages}(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('from', 'reply_to', 'to', 'cc')),
      address TEXT NOT NULL,
      name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.emailAttachments} (
      id UUID PRIMARY KEY,
      message_id UUID NOT NULL REFERENCES ${tables3.emailMessages}(id) ON DELETE CASCADE,
      filename TEXT,
      mime_type TEXT,
      size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
      local_path TEXT,
      content_id TEXT,
      storage_status TEXT NOT NULL DEFAULT 'metadata_only',
      storage_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.emailMessages}
    ADD COLUMN IF NOT EXISTS session_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables3.emailMessages}
    ADD COLUMN IF NOT EXISTS route_id UUID
  `);
  await pool.query(`
    ALTER TABLE ${tables3.emailAttachments}
    ADD COLUMN IF NOT EXISTS storage_status TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables3.emailAttachments}
    ADD COLUMN IF NOT EXISTS storage_reason TEXT
  `);
  await pool.query(`
    UPDATE ${tables3.emailAttachments}
    SET storage_status = CASE
      WHEN local_path IS NOT NULL THEN 'stored'
      ELSE 'metadata_only'
    END
    WHERE storage_status IS NULL
  `);
  await pool.query(`
    UPDATE ${tables3.emailAttachments}
    SET storage_reason = CASE
      WHEN storage_status = 'stored' THEN NULL
      ELSE COALESCE(storage_reason, 'legacy')
    END
    WHERE (storage_status = 'stored' AND storage_reason IS NOT NULL)
      OR (storage_status = 'metadata_only' AND storage_reason IS NULL)
  `);
  await pool.query(`
    ALTER TABLE ${tables3.emailAttachments}
    ALTER COLUMN storage_status SET DEFAULT 'metadata_only'
  `);
  await pool.query(`
    ALTER TABLE ${tables3.emailAttachments}
    ALTER COLUMN storage_status SET NOT NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_accounts_key_idx`)}
    ON ${tables3.emailAccounts} (agent_key, account_key)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_allowed_key_idx`)}
    ON ${tables3.emailAllowedRecipients} (agent_key, account_key, address)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_routes_account_idx`)}
    ON ${tables3.emailRoutes} (agent_key, account_key)
    WHERE mailbox IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_routes_mailbox_idx`)}
    ON ${tables3.emailRoutes} (agent_key, account_key, mailbox)
    WHERE mailbox IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_routes_session_idx`)}
    ON ${tables3.emailRoutes} (session_id, agent_key, account_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_accounts_enabled_idx`)}
    ON ${tables3.emailAccounts} (enabled, agent_key, account_key)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_messages_mailbox_uid_idx`)}
    ON ${tables3.emailMessages} (agent_key, account_key, mailbox, uid_validity, uid)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_messages_thread_idx`)}
    ON ${tables3.emailMessages} (agent_key, account_key, thread_key, COALESCE(received_at, sent_at, created_at))
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_messages_session_idx`)}
    ON ${tables3.emailMessages} (session_id, agent_key, COALESCE(received_at, sent_at, created_at))
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_messages_route_idx`)}
    ON ${tables3.emailMessages} (route_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_email_recipients_message_idx`)}
    ON ${tables3.emailMessageRecipients} (message_id, role)
  `);
  const integrity = buildEmailIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailAccounts}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_accounts_agent_fk`)}
    FOREIGN KEY (agent_key)
    REFERENCES ${agentTableName}(agent_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailAllowedRecipients}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_allowed_account_fk`)}
    FOREIGN KEY (agent_key, account_key)
    REFERENCES ${tables3.emailAccounts}(agent_key, account_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailRoutes}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_routes_account_fk`)}
    FOREIGN KEY (agent_key, account_key)
    REFERENCES ${tables3.emailAccounts}(agent_key, account_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailRoutes}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_routes_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailMessages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_messages_account_fk`)}
    FOREIGN KEY (agent_key, account_key)
    REFERENCES ${tables3.emailAccounts}(agent_key, account_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailMessages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_messages_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailMessages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_messages_route_fk`)}
    FOREIGN KEY (route_id)
    REFERENCES ${tables3.emailRoutes}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailAttachments}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_attachments_storage_status_check`)}
    CHECK (storage_status IN ('stored', 'metadata_only'))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailAttachments}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_attachments_storage_reason_check`)}
    CHECK (
      storage_reason IS NULL
      OR storage_reason IN (
        'backfill',
        'inline',
        'too_many_attachments',
        'attachment_too_large',
        'total_size_limit',
        'legacy'
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.emailAttachments}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_email_attachments_storage_shape_check`)}
    CHECK (
      (storage_status = 'stored' AND local_path IS NOT NULL AND storage_reason IS NULL)
      OR (storage_status = 'metadata_only' AND local_path IS NULL AND storage_reason IS NOT NULL)
    )
  `);
}

// src/domain/execution-environments/postgres-shared.ts
function buildExecutionEnvironmentTableNames() {
  return buildRuntimeRelationNames({
    executionEnvironments: "execution_environments",
    sessionEnvironmentBindings: "session_environment_bindings"
  });
}

// src/domain/execution-environments/postgres-schema.ts
async function ensurePostgresExecutionEnvironmentSchema(pool) {
  const tables3 = buildExecutionEnvironmentTableNames();
  const agentTables = buildAgentTableNames();
  const sessionTables = buildSessionTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.executionEnvironments} (
      id TEXT PRIMARY KEY,
      agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'ready',
      runner_url TEXT,
      runner_cwd TEXT,
      root_path TEXT,
      created_by_session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      created_for_session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      expires_at TIMESTAMPTZ,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.sessionEnvironmentBindings} (
      session_id TEXT NOT NULL REFERENCES ${sessionTables.sessions}(id) ON DELETE CASCADE,
      environment_id TEXT NOT NULL REFERENCES ${tables3.executionEnvironments}(id) ON DELETE CASCADE,
      alias TEXT NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      allow_override BOOLEAN NOT NULL DEFAULT FALSE,
      credential_policy JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb,
      skill_policy JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb,
      tool_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, environment_id)
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.sessionEnvironmentBindings}
    ADD COLUMN IF NOT EXISTS skill_policy JSONB NOT NULL DEFAULT '{"mode":"none"}'::jsonb
  `);
  await pool.query(`
    ALTER TABLE ${tables3.sessionEnvironmentBindings}
    ALTER COLUMN skill_policy SET DEFAULT '{"mode":"none"}'::jsonb
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_environment_alias_idx`)}
    ON ${tables3.sessionEnvironmentBindings} (session_id, alias)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_environment_default_idx`)}
    ON ${tables3.sessionEnvironmentBindings} (session_id)
    WHERE is_default
  `);
}

// src/domain/gateway/postgres-shared.ts
function buildGatewayTableNames() {
  return buildRuntimeRelationNames({
    sources: "gateway_sources",
    devices: "gateway_devices",
    commands: "gateway_device_commands",
    deviceAuditEvents: "gateway_device_audit_events",
    eventTypes: "gateway_event_types",
    accessTokens: "gateway_access_tokens",
    events: "gateway_events",
    attachments: "gateway_attachments",
    eventAttachments: "gateway_event_attachments",
    rateLimits: "gateway_rate_limits",
    strikes: "gateway_strikes"
  });
}

// src/domain/gateway/postgres-schema.ts
async function ensurePostgresGatewaySchema(pool) {
  const tables3 = buildGatewayTableNames();
  const agentTables = buildAgentTableNames();
  const identityTables = buildIdentityTableNames();
  const sessionTables = buildSessionTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.sources} (
      source_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      client_id TEXT NOT NULL UNIQUE,
      client_secret_hash TEXT NOT NULL,
      agent_key TEXT NOT NULL REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      identity_id TEXT NOT NULL REFERENCES ${identityTables.identities}(id) ON DELETE CASCADE,
      session_id TEXT REFERENCES ${sessionTables.sessions}(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active',
      suspended_at TIMESTAMPTZ,
      suspend_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.devices} (
      source_id TEXT NOT NULL REFERENCES ${tables3.sources}(source_id) ON DELETE CASCADE,
      device_id TEXT NOT NULL,
      label TEXT,
      token_hash TEXT NOT NULL UNIQUE,
      capabilities JSONB NOT NULL DEFAULT '[]',
      disabled_at TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_id, device_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_devices_source_idx`)}
    ON ${tables3.devices} (source_id, updated_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.deviceAuditEvents} (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES ${tables3.sources}(source_id) ON DELETE CASCADE,
      device_id TEXT,
      kind TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_device_audit_events_source_device_idx`)}
    ON ${tables3.deviceAuditEvents} (source_id, device_id, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.eventTypes} (
      source_id TEXT NOT NULL REFERENCES ${tables3.sources}(source_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      delivery TEXT NOT NULL,
      trusted BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source_id, event_type)
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.eventTypes}
    ADD COLUMN IF NOT EXISTS trusted BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.accessTokens} (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      source_id TEXT NOT NULL REFERENCES ${tables3.sources}(source_id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_access_tokens_source_idx`)}
    ON ${tables3.accessTokens} (source_id, expires_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.events} (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES ${tables3.sources}(source_id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      delivery_requested TEXT NOT NULL,
      delivery_effective TEXT NOT NULL,
      occurred_at TIMESTAMPTZ,
      idempotency_key TEXT NOT NULL,
      text TEXT NOT NULL,
      text_bytes INTEGER NOT NULL,
      text_sha256 TEXT NOT NULL,
      trusted BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'pending',
      risk_score DOUBLE PRECISION,
      reason TEXT,
      thread_id TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claim_id TEXT,
      claimed_at TIMESTAMPTZ,
      processed_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      text_scrubbed_at TIMESTAMPTZ,
      UNIQUE (source_id, idempotency_key)
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.events}
    ADD COLUMN IF NOT EXISTS trusted BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await pool.query(`
    ALTER TABLE ${tables3.events}
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ
  `);
  await pool.query(`
    ALTER TABLE ${tables3.events}
    ADD COLUMN IF NOT EXISTS claim_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables3.events}
    ADD COLUMN IF NOT EXISTS metadata JSONB
  `);
  await pool.query(`
    ALTER TABLE ${tables3.events}
    ADD COLUMN IF NOT EXISTS text_scrubbed_at TIMESTAMPTZ
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_events_pending_idx`)}
    ON ${tables3.events} (status, created_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.attachments} (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES ${tables3.sources}(source_id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'uploaded',
      scan_status TEXT NOT NULL DEFAULT 'not_scanned',
      mime_type TEXT NOT NULL,
      sniffed_mime_type TEXT,
      filename TEXT,
      size_bytes BIGINT NOT NULL,
      sha256 TEXT NOT NULL,
      local_path TEXT NOT NULL,
      media_source TEXT NOT NULL DEFAULT 'gateway',
      connector_key TEXT NOT NULL,
      media_metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      bound_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      quarantined_at TIMESTAMPTZ,
      scrubbed_at TIMESTAMPTZ,
      UNIQUE (source_id, idempotency_key)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_attachments_source_status_created_idx`)}
    ON ${tables3.attachments} (source_id, status, created_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_attachments_source_expires_idx`)}
    ON ${tables3.attachments} (source_id, expires_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_attachments_sha256_idx`)}
    ON ${tables3.attachments} (sha256)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_attachments_expires_idx`)}
    ON ${tables3.attachments} (expires_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.commands} (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload JSONB,
      status TEXT NOT NULL DEFAULT 'queued',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      claim_id TEXT,
      claimed_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      error TEXT,
      result JSONB,
      result_attachment_id TEXT REFERENCES ${tables3.attachments}(id) ON DELETE SET NULL,
      FOREIGN KEY (source_id, device_id)
        REFERENCES ${tables3.devices}(source_id, device_id) ON DELETE CASCADE
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_device_commands_claim_idx`)}
    ON ${tables3.commands} (source_id, device_id, status, created_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_device_commands_stale_idx`)}
    ON ${tables3.commands} (status, updated_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.eventAttachments} (
      event_id TEXT NOT NULL REFERENCES ${tables3.events}(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL REFERENCES ${tables3.attachments}(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      size_bytes BIGINT NOT NULL,
      mime_type TEXT NOT NULL,
      PRIMARY KEY (event_id, position),
      UNIQUE (event_id, attachment_id),
      UNIQUE (attachment_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.rateLimits} (
      bucket_key TEXT PRIMARY KEY,
      window_start TIMESTAMPTZ NOT NULL,
      used BIGINT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_rate_limits_updated_idx`)}
    ON ${tables3.rateLimits} (updated_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.strikes} (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL REFERENCES ${tables3.sources}(source_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      reason TEXT NOT NULL,
      event_id TEXT REFERENCES ${tables3.events}(id) ON DELETE SET NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.strikes}
    ADD COLUMN IF NOT EXISTS metadata JSONB
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_gateway_strikes_source_kind_idx`)}
    ON ${tables3.strikes} (source_id, kind, created_at DESC)
  `);
}

// src/domain/mcp/postgres-shared.ts
function buildMcpTableNames() {
  return buildRuntimeRelationNames({
    configs: "agent_mcp_configs",
    oauthConnections: "agent_mcp_oauth_connections",
    oauthAttempts: "agent_mcp_oauth_attempts"
  });
}

// src/domain/mcp/postgres-schema.ts
async function ensurePostgresMcpSchema(pool) {
  const tables3 = buildMcpTableNames();
  const agents = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.configs} (
      agent_key TEXT PRIMARY KEY REFERENCES ${agents.agents}(agent_key) ON DELETE CASCADE,
      config JSONB NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.configs}
    ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.oauthConnections} (
      agent_key TEXT NOT NULL REFERENCES ${agents.agents}(agent_key) ON DELETE CASCADE,
      server_name TEXT NOT NULL,
      resource_url TEXT,
      authorization_server_url TEXT,
      state_ciphertext BYTEA NOT NULL,
      state_iv BYTEA NOT NULL,
      state_tag BYTEA NOT NULL,
      key_version SMALLINT NOT NULL,
      version BIGINT NOT NULL DEFAULT 1,
      authorized_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_key, server_name),
      CHECK (server_name <> ''),
      CHECK (version > 0)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.oauthAttempts} (
      state_hash TEXT PRIMARY KEY,
      agent_key TEXT NOT NULL,
      server_name TEXT NOT NULL,
      verifier_ciphertext BYTEA NOT NULL,
      verifier_iv BYTEA NOT NULL,
      verifier_tag BYTEA NOT NULL,
      key_version SMALLINT NOT NULL,
      initiator_kind TEXT NOT NULL DEFAULT 'control' CHECK (initiator_kind IN ('control', 'agent')),
      initiated_identity_id TEXT,
      initiated_session_id TEXT NOT NULL,
      initiated_thread_id TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      FOREIGN KEY (agent_key, server_name)
        REFERENCES ${tables3.oauthConnections}(agent_key, server_name)
        ON DELETE CASCADE,
      CHECK (server_name <> ''),
      CHECK (state_hash <> '')
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.oauthAttempts}
    ADD COLUMN IF NOT EXISTS initiator_kind TEXT NOT NULL DEFAULT 'control'
  `);
  await pool.query(`
    ALTER TABLE ${tables3.oauthAttempts}
    ADD COLUMN IF NOT EXISTS initiated_thread_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables3.oauthAttempts}
    ALTER COLUMN initiated_identity_id DROP NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS agent_mcp_oauth_attempts_server_idx
    ON ${tables3.oauthAttempts} (agent_key, server_name, expires_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_mcp_oauth_attempts_owner_idx
    ON ${tables3.oauthAttempts} (agent_key, server_name)
  `);
}

// src/domain/model-call-traces/postgres-shared.ts
function buildModelCallTraceTableNames() {
  return buildRuntimeRelationNames({
    attempts: "model_call_attempts",
    snapshots: "model_call_snapshots",
    legacyTraces: "model_call_traces"
  });
}

// src/domain/model-call-traces/postgres-schema.ts
async function ensurePostgresModelCallTraceSchema(pool) {
  const tables3 = buildModelCallTraceTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.attempts} (
      id UUID PRIMARY KEY,
      run_id UUID,
      thread_id TEXT,
      session_id TEXT,
      agent_key TEXT,
      turn INTEGER,
      attempt_ordinal INTEGER NOT NULL CHECK (attempt_ordinal >= 1),
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('complete', 'stream')),
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ NOT NULL,
      duration_ms BIGINT NOT NULL,
      prompt_cache_key TEXT,
      usage_captured BOOLEAN NOT NULL DEFAULT FALSE,
      input_tokens BIGINT,
      output_tokens BIGINT,
      cache_read_tokens BIGINT,
      cache_write_tokens BIGINT,
      total_tokens BIGINT,
      input_cost DOUBLE PRECISION,
      output_cost DOUBLE PRECISION,
      cache_read_cost DOUBLE PRECISION,
      cache_write_cost DOUBLE PRECISION,
      total_cost DOUBLE PRECISION,
      error_category TEXT,
      error_message TEXT,
      error_provider TEXT,
      error_model TEXT,
      error_status INTEGER,
      error_retryable BOOLEAN,
      error_timed_out BOOLEAN,
      error_stop_reason TEXT,
      system_prompt_chars INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      tool_count INTEGER NOT NULL,
      context_section_count INTEGER NOT NULL,
      context_chars INTEGER NOT NULL,
      snapshot_status TEXT NOT NULL CHECK (snapshot_status IN ('not_captured', 'captured', 'truncated', 'dropped')),
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.snapshots} (
      attempt_id UUID PRIMARY KEY REFERENCES ${tables3.attempts}(id) ON DELETE CASCADE,
      request_json JSONB NOT NULL,
      response_json JSONB,
      snapshot_bytes BIGINT NOT NULL CHECK (snapshot_bytes >= 0),
      truncated BOOLEAN NOT NULL,
      redaction_version INTEGER NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_model_call_attempts_started_idx`)}
    ON ${tables3.attempts} (started_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_model_call_attempts_expires_idx`)}
    ON ${tables3.attempts} (expires_at)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_model_call_attempts_run_idx`)}
    ON ${tables3.attempts} (run_id, started_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_model_call_attempts_session_started_idx`)}
    ON ${tables3.attempts} (session_id, started_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_model_call_attempts_agent_started_idx`)}
    ON ${tables3.attempts} (agent_key, started_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_model_call_attempts_failure_idx`)}
    ON ${tables3.attempts} (provider, model, mode, error_category, started_at DESC)
    WHERE status = 'failed'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_model_call_snapshots_expires_idx`)}
    ON ${tables3.snapshots} (expires_at)
  `);
  await pool.query(`DROP TABLE IF EXISTS ${tables3.legacyTraces}`);
}

// src/domain/scheduling/tasks/postgres-shared.ts
function buildScheduledTaskTableNames() {
  return buildRuntimeRelationNames({
    scheduledTasks: "scheduled_tasks",
    scheduledTaskRuns: "scheduled_task_runs"
  });
}

// src/domain/scheduling/tasks/postgres-schema.ts
function buildScheduledTaskIntegrityChecks() {
  const tables3 = buildScheduledTaskTableNames();
  const threadTables = buildThreadRuntimeTableNames();
  return { scope: "Scheduled task schema", checks: [
    {
      label: "scheduled_tasks.created_from_message_id orphaned from messages.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTasks} AS task
        LEFT JOIN ${threadTables.messages} AS message
          ON message.id = task.created_from_message_id
        WHERE task.created_from_message_id IS NOT NULL
          AND message.id IS NULL
      `
    },
    {
      label: "scheduled_task_runs.task_id orphaned from scheduled_tasks.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns} AS run
        LEFT JOIN ${tables3.scheduledTasks} AS task
          ON task.id = run.task_id
        WHERE task.id IS NULL
      `
    },
    {
      label: "scheduled_task_runs task/session mismatch",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns} AS run
        INNER JOIN ${tables3.scheduledTasks} AS task
          ON task.id = run.task_id
        WHERE task.session_id <> run.session_id
      `
    },
    {
      label: "scheduled_task_runs tasks with multiple active occurrences",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM (
          SELECT task_id
          FROM ${tables3.scheduledTaskRuns}
          WHERE status IN ('pending', 'claimed', 'running')
          GROUP BY task_id
          HAVING COUNT(*) > 1
        ) AS duplicates
      `
    },
    {
      label: "scheduled_tasks next_fire_at repeats an existing occurrence",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTasks} AS task
        INNER JOIN ${tables3.scheduledTaskRuns} AS run
          ON run.task_id = task.id
         AND run.scheduled_for = task.next_fire_at
        WHERE task.enabled = TRUE
          AND task.completed_at IS NULL
          AND task.cancelled_at IS NULL
          AND task.next_fire_at IS NOT NULL
      `
    },
    {
      label: "scheduled_task_runs.resolved_thread_id orphaned from threads.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns} AS run
        LEFT JOIN ${threadTables.threads} AS thread
          ON thread.id = run.resolved_thread_id
        WHERE run.resolved_thread_id IS NOT NULL
          AND thread.id IS NULL
      `
    },
    {
      label: "scheduled_task_runs.resolved_thread_id bound to another session",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns} AS run
        INNER JOIN ${threadTables.threads} AS thread
          ON thread.id = run.resolved_thread_id
        WHERE run.resolved_thread_id IS NOT NULL
          AND thread.session_id <> run.session_id
      `
    },
    {
      label: "scheduled_task_runs.thread_input_id orphaned from inputs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns} AS run
        LEFT JOIN ${threadTables.inputs} AS thread_input
          ON thread_input.id = run.thread_input_id
        WHERE run.thread_input_id IS NOT NULL
          AND thread_input.id IS NULL
      `
    },
    {
      label: "scheduled_task_runs.thread_input_id set without resolved_thread_id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns}
        WHERE thread_input_id IS NOT NULL
          AND resolved_thread_id IS NULL
      `
    },
    {
      label: "scheduled_task_runs.thread_input_id differs from occurrence id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns}
        WHERE thread_input_id IS NOT NULL
          AND thread_input_id <> id
      `
    },
    {
      label: "scheduled_task_runs.thread_input_id bound to another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns} AS run
        INNER JOIN ${threadTables.inputs} AS thread_input
          ON thread_input.id = run.thread_input_id
        WHERE run.thread_input_id IS NOT NULL
          AND thread_input.thread_id <> run.resolved_thread_id
      `
    },
    {
      label: "scheduled_task_runs.thread_input_id lacks its scheduled-task fingerprint",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns} AS run
        INNER JOIN ${threadTables.inputs} AS thread_input
          ON thread_input.id = run.thread_input_id
        WHERE run.thread_input_id IS NOT NULL
          AND (
            thread_input.source <> 'scheduled_task'
            OR COALESCE(thread_input.external_message_id, '') <> run.id::text
          )
      `
    },
    {
      label: "scheduled_task_runs.thread_run_id orphaned from runs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns} AS run
        LEFT JOIN ${threadTables.runs} AS thread_run
          ON thread_run.id = run.thread_run_id
        WHERE run.thread_run_id IS NOT NULL
          AND thread_run.id IS NULL
      `
    },
    {
      label: "scheduled_task_runs.thread_run_id set without resolved_thread_id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns}
        WHERE thread_run_id IS NOT NULL
          AND resolved_thread_id IS NULL
      `
    },
    {
      label: "scheduled_task_runs.thread_run_id bound to another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.scheduledTaskRuns} AS run
        INNER JOIN ${threadTables.runs} AS thread_run
          ON thread_run.id = run.thread_run_id
        WHERE run.thread_run_id IS NOT NULL
          AND thread_run.thread_id <> run.resolved_thread_id
      `
    }
  ] };
}
async function ensurePostgresScheduledTaskSchema(pool) {
  const tables3 = buildScheduledTaskTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;
  const threadTables = buildThreadRuntimeTableNames();
  const threadTableName = threadTables.threads;
  const inputTableName = threadTables.inputs;
  const messageTableName = threadTables.messages;
  const runTableName = threadTables.runs;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.scheduledTasks} (
      id UUID PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      created_from_message_id UUID,
      title TEXT NOT NULL,
      instruction TEXT NOT NULL,
      schedule_kind TEXT NOT NULL,
      run_at TIMESTAMPTZ,
      cron_expr TEXT,
      timezone TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      completed_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      next_fire_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_tasks_due_idx`)}
    ON ${tables3.scheduledTasks} (enabled, cancelled_at, completed_at, next_fire_at, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_tasks_identity_agent_idx`)}
    ON ${tables3.scheduledTasks} (session_id, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_tasks_session_fire_idx`)}
    ON ${tables3.scheduledTasks} (session_id, next_fire_at ASC, created_at DESC, id ASC)
    WHERE enabled = TRUE
      AND completed_at IS NULL
      AND cancelled_at IS NULL
      AND next_fire_at IS NOT NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_tasks_session_id_id_idx`)}
    ON ${tables3.scheduledTasks} (session_id, id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.scheduledTaskRuns} (
      id UUID PRIMARY KEY,
      task_id UUID NOT NULL,
      session_id TEXT NOT NULL,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      resolved_thread_id TEXT,
      resolved_thread_session_id TEXT,
      scheduled_for TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      thread_input_id UUID,
      thread_input_thread_id TEXT,
      thread_run_id UUID,
      thread_run_thread_id TEXT,
      claim_token UUID,
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      claim_expires_at TIMESTAMPTZ,
      lineage_recorded_at TIMESTAMPTZ,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.scheduledTasks}
    DROP COLUMN IF EXISTS deliver_at CASCADE,
    DROP COLUMN IF EXISTS next_fire_kind CASCADE
  `);
  await pool.query(`
    ALTER TABLE ${tables3.scheduledTaskRuns}
    DROP COLUMN IF EXISTS fire_kind CASCADE,
    DROP COLUMN IF EXISTS delivery_status CASCADE
  `);
  await pool.query(`
    DROP INDEX IF EXISTS ${quoteIdentifier(tables3.prefix)}.${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_task_created_idx`)}
  `);
  await pool.query(`
    CREATE INDEX ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_task_created_idx`)}
    ON ${tables3.scheduledTaskRuns} (session_id, task_id, created_at DESC, id ASC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_session_created_idx`)}
    ON ${tables3.scheduledTaskRuns} (session_id, created_at DESC, id ASC)
  `);
  await assertIntegrityChecks(pool, "Scheduled task schema", [{
    label: "duplicate scheduled_task_runs (task_id, scheduled_for) occurrences",
    sql: `
      SELECT COUNT(*)::INTEGER AS count
      FROM (
        SELECT task_id, scheduled_for
        FROM ${tables3.scheduledTaskRuns}
        GROUP BY task_id, scheduled_for
        HAVING COUNT(*) > 1
      ) AS duplicates
    `
  }]);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_task_fire_idx`)}
    ON ${tables3.scheduledTaskRuns} (task_id, scheduled_for)
  `);
  await pool.query(`
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD COLUMN IF NOT EXISTS resolved_thread_session_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD COLUMN IF NOT EXISTS thread_run_thread_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD COLUMN IF NOT EXISTS thread_input_id UUID,
    ADD COLUMN IF NOT EXISTS thread_input_thread_id TEXT,
    ADD COLUMN IF NOT EXISTS claim_token UUID,
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS claimed_by TEXT,
    ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS lineage_recorded_at TIMESTAMPTZ
  `);
  const legacyTaskClaimColumns = await pool.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'scheduled_tasks'
      AND column_name = 'claimed_at'
    LIMIT 1
  `);
  if (legacyTaskClaimColumns.rows.length > 0) {
    await pool.query(`
      UPDATE ${tables3.scheduledTaskRuns}
      SET status = 'pending'
      WHERE status = 'claimed'
    `);
  }
  await pool.query(`
    UPDATE ${tables3.scheduledTaskRuns}
    SET status = 'failed',
        error = COALESCE(error, 'Interrupted during the scheduled input-lineage migration.'),
        finished_at = COALESCE(finished_at, NOW())
    WHERE status = 'running'
      AND thread_input_id IS NULL
  `);
  await pool.query(`
    UPDATE ${tables3.scheduledTaskRuns}
    SET lineage_recorded_at = COALESCE(started_at, finished_at, created_at)
    WHERE status = 'succeeded'
      AND lineage_recorded_at IS NULL
  `);
  await pool.query(`
    UPDATE ${tables3.scheduledTasks}
    SET next_fire_at = NULL,
        updated_at = NOW()
    WHERE schedule_kind = 'once'
      AND next_fire_at IS NOT NULL
      AND id IN (
        SELECT run.task_id
        FROM ${tables3.scheduledTaskRuns} AS run
        WHERE run.status IN ('pending', 'claimed', 'running')
      )
  `);
  await pool.query(`
    UPDATE ${tables3.scheduledTasks}
    SET completed_at = COALESCE(completed_at, NOW()),
        next_fire_at = NULL,
        updated_at = NOW()
    WHERE schedule_kind = 'once'
      AND completed_at IS NULL
      AND id IN (
        SELECT run.task_id
        FROM ${tables3.scheduledTaskRuns} AS run
        WHERE run.status = 'failed'
          AND run.error = 'Interrupted during the scheduled input-lineage migration.'
      )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.scheduledTasks}
    DROP COLUMN IF EXISTS claimed_at CASCADE,
    DROP COLUMN IF EXISTS claimed_by CASCADE,
    DROP COLUMN IF EXISTS claim_expires_at CASCADE
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_claimable_idx`)}
    ON ${tables3.scheduledTaskRuns} (status, claim_expires_at, scheduled_for, id)
    WHERE status IN ('pending', 'claimed', 'running')
  `);
  await assertIntegrityChecks(pool, "Scheduled task schema", [{
    label: "scheduled_task_runs tasks with multiple active occurrences",
    sql: `
      SELECT COUNT(*)::INTEGER AS count
      FROM (
        SELECT task_id
        FROM ${tables3.scheduledTaskRuns}
        WHERE status IN ('pending', 'claimed', 'running')
        GROUP BY task_id
        HAVING COUNT(*) > 1
      ) AS duplicates
    `
  }]);
  await pool.query(`
    DROP INDEX IF EXISTS ${quoteIdentifier(tables3.prefix)}.${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_active_task_idx`)}
  `);
  await pool.query(`
    CREATE UNIQUE INDEX ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_active_task_idx`)}
    ON ${tables3.scheduledTaskRuns} (task_id)
    WHERE status IN ('pending', 'claimed', 'running')
  `);
  await pool.query(`
    ALTER TABLE ${tables3.scheduledTasks}
    ADD COLUMN IF NOT EXISTS created_from_message_id UUID
  `);
  const threadRunTypeResult = await pool.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'runtime'
      AND table_name = 'scheduled_task_runs'
      AND column_name = 'thread_run_id'
  `);
  const threadRunType = String(threadRunTypeResult.rows[0]?.data_type ?? "");
  if (threadRunType && threadRunType !== "uuid") {
    await assertIntegrityChecks(pool, "Scheduled task schema", [
      {
        label: "scheduled_task_runs.thread_run_id invalid UUID format",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.scheduledTaskRuns}
          WHERE thread_run_id IS NOT NULL
            AND BTRIM(thread_run_id::text) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        `
      }
    ]);
    await pool.query(`
      ALTER TABLE ${tables3.scheduledTaskRuns}
      ALTER COLUMN thread_run_id TYPE UUID
      USING CASE
        WHEN thread_run_id IS NULL THEN NULL
        ELSE thread_run_id::uuid
      END
    `);
  }
  const integrity = buildScheduledTaskIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await pool.query(`
    UPDATE ${tables3.scheduledTaskRuns}
    SET resolved_thread_session_id = NULL
    WHERE resolved_thread_id IS NULL
      AND resolved_thread_session_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables3.scheduledTaskRuns}
    SET resolved_thread_session_id = thread.session_id
    FROM ${threadTableName} AS thread
    WHERE ${tables3.scheduledTaskRuns}.resolved_thread_id IS NOT NULL
      AND thread.id = ${tables3.scheduledTaskRuns}.resolved_thread_id
      AND (
        ${tables3.scheduledTaskRuns}.resolved_thread_session_id IS NULL
        OR ${tables3.scheduledTaskRuns}.resolved_thread_session_id <> thread.session_id
      )
  `);
  await pool.query(`
    UPDATE ${tables3.scheduledTaskRuns}
    SET thread_input_thread_id = NULL
    WHERE thread_input_id IS NULL
      AND thread_input_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables3.scheduledTaskRuns}
    SET thread_input_thread_id = thread_input.thread_id
    FROM ${inputTableName} AS thread_input
    WHERE ${tables3.scheduledTaskRuns}.thread_input_id IS NOT NULL
      AND thread_input.id = ${tables3.scheduledTaskRuns}.thread_input_id
      AND (
        ${tables3.scheduledTaskRuns}.thread_input_thread_id IS NULL
        OR ${tables3.scheduledTaskRuns}.thread_input_thread_id <> thread_input.thread_id
      )
  `);
  await pool.query(`
    UPDATE ${tables3.scheduledTaskRuns}
    SET thread_run_thread_id = NULL
    WHERE thread_run_id IS NULL
      AND thread_run_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables3.scheduledTaskRuns}
    SET thread_run_thread_id = thread_run.thread_id
    FROM ${runTableName} AS thread_run
    WHERE ${tables3.scheduledTaskRuns}.thread_run_id IS NOT NULL
      AND thread_run.id = ${tables3.scheduledTaskRuns}.thread_run_id
      AND (
        ${tables3.scheduledTaskRuns}.thread_run_thread_id IS NULL
        OR ${tables3.scheduledTaskRuns}.thread_run_thread_id <> thread_run.thread_id
      )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_status_check`)}
    CHECK (status IN ('pending', 'claimed', 'running', 'succeeded', 'failed', 'cancelled'))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_lifecycle_check`)}
    CHECK (
      (status <> 'pending' OR (
        claim_token IS NULL
        AND thread_input_id IS NULL
        AND thread_run_id IS NULL
        AND lineage_recorded_at IS NULL
        AND started_at IS NULL
        AND finished_at IS NULL
      ))
      AND (status <> 'claimed' OR (
        claim_token IS NOT NULL
        AND thread_input_id IS NULL
        AND thread_run_id IS NULL
        AND lineage_recorded_at IS NULL
        AND started_at IS NULL
        AND finished_at IS NULL
      ))
      AND (status <> 'running' OR (
        claim_token IS NOT NULL
        AND resolved_thread_id IS NOT NULL
        AND thread_input_id IS NOT NULL
        AND thread_run_id IS NULL
        AND lineage_recorded_at IS NOT NULL
        AND started_at IS NOT NULL
        AND finished_at IS NULL
      ))
      AND (status <> 'succeeded' OR (
        lineage_recorded_at IS NOT NULL
        AND started_at IS NOT NULL
        AND finished_at IS NOT NULL
        AND error IS NULL
      ))
      AND (status <> 'failed' OR (
        error IS NOT NULL
        AND finished_at IS NOT NULL
      ))
      AND (status <> 'cancelled' OR (
        finished_at IS NOT NULL
      ))
      AND (status NOT IN ('succeeded', 'failed', 'cancelled') OR (
        claim_token IS NULL
        AND claim_expires_at IS NULL
        AND finished_at IS NOT NULL
      ))
      AND (
        (claim_token IS NULL AND claim_expires_at IS NULL)
        OR (
          claim_token IS NOT NULL
          AND claimed_at IS NOT NULL
          AND claimed_by IS NOT NULL
          AND claim_expires_at IS NOT NULL
        )
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTasks}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_tasks_created_from_message_fk`)}
    FOREIGN KEY (created_from_message_id)
    REFERENCES ${messageTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_task_scope_fk`)}
    FOREIGN KEY (session_id, task_id)
    REFERENCES ${tables3.scheduledTasks}(session_id, id)
    ON DELETE CASCADE
  `);
  await pool.query(`
    ALTER TABLE ${tables3.scheduledTaskRuns}
    DROP CONSTRAINT IF EXISTS scheduled_task_runs_task_id_fkey,
    DROP CONSTRAINT IF EXISTS scheduled_task_runs_session_id_fkey
  `);
  await pool.query(`
    ALTER TABLE ${tables3.scheduledTaskRuns}
    DROP CONSTRAINT IF EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_resolved_thread_fk`)},
    DROP CONSTRAINT IF EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_thread_run_fk`)},
    DROP CONSTRAINT IF EXISTS ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_thread_run_scope_check`)}
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_stable_input_check`)}
    CHECK (thread_input_id IS NULL OR thread_input_id = id)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_thread_input_scope_check`)}
    CHECK (
      (
        thread_input_id IS NULL
        AND thread_input_thread_id IS NULL
      ) OR (
        thread_input_id IS NOT NULL
        AND thread_input_thread_id IS NOT NULL
        AND (
          thread_input_thread_id = resolved_thread_id
          OR (status IN ('succeeded', 'failed', 'cancelled') AND resolved_thread_id IS NULL)
        )
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_thread_input_scope_fk`)}
    FOREIGN KEY (thread_input_thread_id, thread_input_id)
    REFERENCES ${inputTableName}(thread_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_resolved_thread_scope_check`)}
    CHECK (
      (
        resolved_thread_id IS NULL
        AND resolved_thread_session_id IS NULL
      ) OR (
        resolved_thread_id IS NOT NULL
        AND resolved_thread_session_id = session_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_resolved_thread_scope_fk`)}
    FOREIGN KEY (resolved_thread_session_id, resolved_thread_id)
    REFERENCES ${threadTableName}(session_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_thread_run_scope_check`)}
    CHECK (
      (
        thread_run_id IS NULL
        AND thread_run_thread_id IS NULL
      ) OR (
        thread_run_id IS NOT NULL
        AND thread_run_thread_id IS NOT NULL
        AND (
          thread_run_thread_id = resolved_thread_id
          OR (status IN ('succeeded', 'failed', 'cancelled') AND resolved_thread_id IS NULL)
        )
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.scheduledTaskRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_scheduled_task_runs_thread_run_scope_fk`)}
    FOREIGN KEY (thread_run_thread_id, thread_run_id)
    REFERENCES ${runTableName}(thread_id, id)
    ON DELETE SET NULL
  `);
}

// src/domain/sessions/conversations/postgres-shared.ts
function buildConversationSessionTableNames() {
  return buildRuntimeRelationNames({
    conversationSessions: "conversation_sessions"
  });
}

// src/domain/sessions/conversations/postgres-schema.ts
function buildConversationSessionIntegrityChecks() {
  const tables3 = buildConversationSessionTableNames();
  const sessionTableName = buildSessionTableNames().sessions;
  return {
    scope: "Conversation binding schema",
    checks: [{
      label: "conversation_sessions.session_id orphaned from agent_sessions.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.conversationSessions} AS binding
        LEFT JOIN ${sessionTableName} AS session
          ON session.id = binding.session_id
        WHERE session.id IS NULL
      `
    }]
  };
}
async function ensurePostgresConversationSessionSchema(pool) {
  const tables3 = buildConversationSessionTableNames();
  const sessionTableName = buildSessionTableNames().sessions;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.conversationSessions} (
      source TEXT NOT NULL,
      connector_key TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (source, connector_key, external_conversation_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_conversation_sessions_session_id_idx`)}
    ON ${tables3.conversationSessions} (session_id)
  `);
  const integrity = buildConversationSessionIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.conversationSessions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_conversation_sessions_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
}

// src/domain/sessions/types.ts
var SESSION_BRIEF_PROMPT_SLUG = "brief";
var SESSION_HEARTBEAT_PROMPT_SLUG = "heartbeat";
var DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES = 60;

// src/domain/sessions/postgres-schema.ts
function buildSessionIntegrityChecks() {
  const tables3 = buildSessionTableNames();
  const agentTableName = buildAgentTableNames().agents;
  const identityTableName = buildIdentityTableNames().identities;
  return {
    scope: "Session schema",
    checks: [
      {
        label: "agent_sessions.agent_key orphaned from agents.agent_key",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.sessions} AS session
          LEFT JOIN ${agentTableName} AS agent
            ON agent.agent_key = session.agent_key
          WHERE agent.agent_key IS NULL
        `
      },
      {
        label: "agent_sessions.created_by_identity_id orphaned from identities.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.sessions} AS session
          LEFT JOIN ${identityTableName} AS identity
            ON identity.id = session.created_by_identity_id
          WHERE session.created_by_identity_id IS NOT NULL
            AND identity.id IS NULL
        `
      },
      {
        label: "session_runtime_config.session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.sessionRuntimeConfig} AS config
          LEFT JOIN ${tables3.sessions} AS session
            ON session.id = config.session_id
          WHERE session.id IS NULL
        `
      }
    ]
  };
}
async function migrateLegacyPromptStorage(pool) {
  const tables3 = buildSessionTableNames();
  const agentTables = buildAgentTableNames();
  const legacyAgentPromptsExist = await postgresRelationExists(pool, "runtime", "agent_prompts");
  const legacyReadonlyAgentPromptsExist = await postgresRelationExists(pool, "session", "agent_prompts");
  if (legacyAgentPromptsExist) {
    await pool.query(`
      INSERT INTO ${tables3.sessionPrompts} (
        session_id,
        slug,
        content
      )
      SELECT
        session_id,
        '${SESSION_BRIEF_PROMPT_SLUG}',
        CASE
          WHEN agent_content IS NOT NULL AND session_content IS NOT NULL THEN agent_content || E'

' || session_content
          ELSE COALESCE(agent_content, session_content)
        END
      FROM (
        SELECT
          session.id AS session_id,
          NULLIF(BTRIM(agent_prompt.content), '') AS agent_content,
          NULLIF(BTRIM(session_prompt.content), '') AS session_content
        FROM ${tables3.sessions} AS session
        LEFT JOIN ${agentTables.agentPrompts} AS agent_prompt
          ON agent_prompt.agent_key = session.agent_key
         AND agent_prompt.slug = 'agent'
        LEFT JOIN ${tables3.sessionPrompts} AS session_prompt
          ON session_prompt.session_id = session.id
         AND session_prompt.slug = 'session'
        WHERE session.kind IN ('main', 'branch')
      ) AS normalized
      WHERE COALESCE(agent_content, session_content) IS NOT NULL
      ON CONFLICT (session_id, slug) DO NOTHING
    `);
    await pool.query(`
      INSERT INTO ${tables3.sessionPrompts} (
        session_id,
        slug,
        content
      )
      SELECT
        session.id,
        '${SESSION_HEARTBEAT_PROMPT_SLUG}',
        NULLIF(BTRIM(agent_prompt.content), '')
      FROM ${tables3.sessions} AS session
      INNER JOIN ${agentTables.agentPrompts} AS agent_prompt
        ON agent_prompt.agent_key = session.agent_key
       AND agent_prompt.slug = 'heartbeat'
      WHERE session.kind IN ('main', 'branch')
        AND NULLIF(BTRIM(agent_prompt.content), '') IS NOT NULL
      ON CONFLICT (session_id, slug) DO NOTHING
    `);
  }
  await pool.query(`
    DELETE FROM ${tables3.sessionPrompts}
    WHERE slug = 'session'
  `);
  if (legacyReadonlyAgentPromptsExist) {
    await pool.query(`DROP VIEW ${quoteQualifiedIdentifier("session", "agent_prompts")}`);
  }
  await pool.query(`DROP TABLE IF EXISTS ${agentTables.agentPrompts}`);
}
async function ensurePostgresSessionSchema(pool) {
  const tables3 = buildSessionTableNames();
  const agentTableName = buildAgentTableNames().agents;
  const identityTableName = buildIdentityTableNames().identities;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.sessions} (
      id TEXT PRIMARY KEY,
      agent_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      current_thread_id TEXT NOT NULL,
      created_by_identity_id TEXT,
      alias TEXT,
      display_name TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    ALTER TABLE ${tables3.sessions}
    ADD COLUMN IF NOT EXISTS alias TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables3.sessions}
    ADD COLUMN IF NOT EXISTS display_name TEXT
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_agent_sessions_main_idx`)}
    ON ${tables3.sessions} (agent_key)
    WHERE kind = 'main'
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_agent_sessions_agent_alias_idx`)}
    ON ${tables3.sessions} (agent_key, alias)
    WHERE alias IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_agent_sessions_agent_idx`)}
    ON ${tables3.sessions} (agent_key, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.sessionRuntimeConfig} (
      session_id TEXT NOT NULL,
      model TEXT,
      thinking TEXT,
      thinking_configured BOOLEAN NOT NULL DEFAULT FALSE,
      inference_projection JSONB,
      pending_wake_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_runtime_config_session_idx`)}
    ON ${tables3.sessionRuntimeConfig} (session_id)
  `);
  await pool.query(`
    ALTER TABLE ${tables3.sessionRuntimeConfig}
    ADD COLUMN IF NOT EXISTS thinking_configured BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await pool.query(`
    ALTER TABLE ${tables3.sessionRuntimeConfig}
    ADD COLUMN IF NOT EXISTS inference_projection JSONB
  `);
  await pool.query(`
    ALTER TABLE ${tables3.sessionRuntimeConfig}
    ADD COLUMN IF NOT EXISTS pending_wake_at TIMESTAMPTZ
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.sessionHeartbeats} (
      session_id TEXT PRIMARY KEY REFERENCES ${tables3.sessions}(id) ON DELETE CASCADE,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      every_minutes INTEGER NOT NULL DEFAULT ${DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES},
      next_fire_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '${DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES} minutes',
      last_fire_at TIMESTAMPTZ,
      last_skip_reason TEXT,
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      claim_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_heartbeats_due_idx`)}
    ON ${tables3.sessionHeartbeats} (enabled, next_fire_at, claim_expires_at, session_id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.sessionPrompts} (
      session_id TEXT NOT NULL REFERENCES ${tables3.sessions}(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, slug)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_prompts_session_idx`)}
      ON ${tables3.sessionPrompts} (session_id)
  `);
  await migrateLegacyPromptStorage(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.sessionTodos} (
      session_id TEXT PRIMARY KEY REFERENCES ${tables3.sessions}(id) ON DELETE CASCADE,
      items JSONB NOT NULL,
      items_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const integrity = buildSessionIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.sessions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_agent_sessions_agent_fk`)}
    FOREIGN KEY (agent_key)
    REFERENCES ${agentTableName}(agent_key)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.sessions}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_agent_sessions_created_by_identity_fk`)}
    FOREIGN KEY (created_by_identity_id)
    REFERENCES ${identityTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.sessionRuntimeConfig}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_session_runtime_config_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${tables3.sessions}(id)
    ON DELETE CASCADE
  `);
}

// src/domain/sessions/routes/postgres-shared.ts
function buildSessionRouteTableNames() {
  return buildRuntimeRelationNames({
    sessionRoutes: "session_routes"
  });
}

// src/domain/sessions/routes/postgres-schema.ts
async function readSessionRouteColumnNames(pool) {
  const result = await pool.query(`
    SELECT table_schema, column_name
    FROM information_schema.columns
    WHERE table_name = 'session_routes'
  `);
  const runtimeColumns = result.rows.filter((row) => {
    return String(row.table_schema ?? "") === "runtime";
  });
  const rows = runtimeColumns.length > 0 ? runtimeColumns : result.rows;
  return new Set(rows.map((row) => String(row.column_name ?? "")));
}
async function createSessionRoutesTable(pool, tableName, options = {}) {
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
function buildSessionRouteIntegrityChecks(tables3 = buildSessionRouteTableNames(), options = { trimIdentityId: false }) {
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;
  const identityReference = options.trimIdentityId ? "NULLIF(BTRIM(route.identity_id), '')" : "route.identity_id";
  return { scope: "Session route schema", checks: [
    {
      label: "session_routes.session_id orphaned from agent_sessions.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.sessionRoutes} AS route
        LEFT JOIN ${sessionTableName} AS session
          ON session.id = route.session_id
        WHERE session.id IS NULL
      `
    },
    {
      label: "session_routes.identity_id orphaned from identities.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.sessionRoutes} AS route
        LEFT JOIN ${identityTableName} AS identity
          ON identity.id = ${identityReference}
        WHERE ${identityReference} IS NOT NULL
          AND identity.id IS NULL
      `
    }
  ] };
}
async function assertSessionRouteIntegrity(pool, tables3, options) {
  const group = buildSessionRouteIntegrityChecks(tables3, options);
  await assertIntegrityChecks(pool, group.scope, group.checks);
}
async function rebuildLegacySessionRoutesTable(pool, tables3) {
  const replacementTable = `"runtime"."session_routes_rebuild"`;
  await pool.query(`DROP TABLE IF EXISTS ${replacementTable}`);
  await createSessionRoutesTable(pool, replacementTable, { ifNotExists: false });
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
    FROM ${tables3.sessionRoutes}
  `);
  await pool.query(`DROP TABLE ${tables3.sessionRoutes}`);
  await pool.query(`ALTER TABLE ${replacementTable} RENAME TO session_routes`);
  await pool.query(`ALTER SEQUENCE IF EXISTS "runtime"."session_routes_rebuild_id_seq" RENAME TO session_routes_id_seq`);
  await alterIfSupported(
    pool,
    `ALTER TABLE ${tables3.sessionRoutes} RENAME CONSTRAINT session_routes_rebuild_pkey TO session_routes_pkey`
  );
}
async function ensurePostgresSessionRouteSchema(pool) {
  const tables3 = buildSessionRouteTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  const existingColumns = await readSessionRouteColumnNames(pool);
  if (existingColumns.size === 0) {
    await createSessionRoutesTable(pool, tables3.sessionRoutes);
  } else if (!existingColumns.has("id")) {
    await assertSessionRouteIntegrity(pool, tables3, { trimIdentityId: true });
    await rebuildLegacySessionRoutesTable(pool, tables3);
  } else {
    await createSessionRoutesTable(pool, tables3.sessionRoutes);
  }
  await pool.query(`
    ALTER TABLE ${tables3.sessionRoutes}
    ALTER COLUMN identity_id DROP NOT NULL
  `);
  await pool.query(`
    ALTER TABLE ${tables3.sessionRoutes}
    ALTER COLUMN identity_id DROP DEFAULT
  `);
  const legacyLookupIndex = `${tables3.prefix}_session_routes_lookup_idx`;
  await pool.query(`DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(tables3.prefix, legacyLookupIndex)}`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_routes_latest_identity_idx`)}
    ON ${tables3.sessionRoutes} (
      session_id,
      identity_id,
      captured_at_ms DESC,
      updated_at DESC,
      id DESC
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_routes_global_unique_idx`)}
    ON ${tables3.sessionRoutes} (session_id, channel)
    WHERE identity_id IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_session_routes_identity_unique_idx`)}
    ON ${tables3.sessionRoutes} (session_id, identity_id, channel)
    WHERE identity_id IS NOT NULL
  `);
  await assertSessionRouteIntegrity(pool, tables3, { trimIdentityId: false });
  await addConstraint(pool, `
    ALTER TABLE ${tables3.sessionRoutes}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_session_routes_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.sessionRoutes}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_session_routes_identity_fk`)}
    FOREIGN KEY (identity_id)
    REFERENCES ${identityTableName}(id)
    ON DELETE CASCADE
  `);
}

// src/domain/execution-environments/policy.ts
var AGENT_SKILL_OPERATIONS = ["load", "set", "patch", "delete"];
var AGENT_SKILL_OPERATION_SET = new Set(AGENT_SKILL_OPERATIONS);

// src/domain/subagents/tool-groups.ts
var ALL_AGENT_SKILL_OPERATIONS = ["load", "set", "patch", "delete"];
var SUBAGENT_TOOL_GROUP_DEFINITIONS = {
  core: {
    description: "Universal command transport, local artifact preview, and parent A2A updates.",
    nativeToolNames: [
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
      "view_media"
    ],
    agentSkillOperations: ["load"]
  },
  internet: {
    description: "Public web lookup, research, and browser inspection.",
    nativeToolNames: [
      "browser"
    ]
  },
  memory: {
    description: "Durable Panda memory and wiki operations.",
    nativeToolNames: [],
    postgresReadonly: { allowed: true }
  },
  skill_maintenance: {
    description: "Narrow durable skill load/create/patch/delete access without broad operational tools.",
    nativeToolNames: [],
    agentSkillOperations: ALL_AGENT_SKILL_OPERATIONS
  },
  operate: {
    description: "Operational mutation and control surfaces.",
    nativeToolNames: [
      "thinking_set"
    ],
    agentSkillOperations: ALL_AGENT_SKILL_OPERATIONS
  },
  communicate_human: {
    description: "Human/channel outbound communication surfaces.",
    nativeToolNames: []
  },
  mcp: {
    description: "Configured Model Context Protocol server tool discovery and calls.",
    nativeToolNames: []
  }
};
var SUBAGENT_TOOL_GROUP_KEYS = Object.keys(
  SUBAGENT_TOOL_GROUP_DEFINITIONS
);
var SUBAGENT_TOOL_GROUP_KEY_SET = new Set(SUBAGENT_TOOL_GROUP_KEYS);

// src/domain/subagents/types.ts
var MAX_SUBAGENT_PROFILE_DESCRIPTION_CHARS = 255;
var SUBAGENT_PROFILE_THINKING_LEVELS = ["low", "medium", "high", "xhigh"];
var THINKING_LEVEL_SET = new Set(SUBAGENT_PROFILE_THINKING_LEVELS);

// src/domain/subagents/postgres-shared.ts
function buildSubagentTableNames() {
  return buildRuntimeRelationNames({
    subagentProfiles: "subagent_profiles"
  });
}

// src/domain/subagents/postgres-schema.ts
async function ensurePostgresSubagentSchema(pool) {
  const tables3 = buildSubagentTableNames();
  const agentTables = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.subagentProfiles} (
      slug TEXT NOT NULL,
      agent_key TEXT REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      description TEXT NOT NULL CHECK (length(description) <= ${MAX_SUBAGENT_PROFILE_DESCRIPTION_CHARS}),
      prompt TEXT NOT NULL,
      tool_groups JSONB NOT NULL,
      model TEXT,
      thinking TEXT,
      transcript_mode TEXT NOT NULL DEFAULT 'none' CHECK (transcript_mode = 'none'),
      source TEXT NOT NULL CHECK (source IN ('builtin', 'custom')),
      created_by_agent_key TEXT REFERENCES ${agentTables.agents}(agent_key) ON DELETE SET NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_subagent_profiles_global_slug_idx`)}
    ON ${tables3.subagentProfiles} (slug)
    WHERE agent_key IS NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_subagent_profiles_agent_slug_idx`)}
    ON ${tables3.subagentProfiles} (agent_key, slug)
    WHERE agent_key IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_subagent_profiles_enabled_slug_idx`)}
    ON ${tables3.subagentProfiles} (enabled, slug)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_subagent_profiles_agent_enabled_slug_idx`)}
    ON ${tables3.subagentProfiles} (agent_key, enabled, slug)
  `);
}

// src/lib/json.ts
function isJsonValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isJsonObject(value);
}
function isJsonObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every(isJsonValue);
}

// src/domain/threads/requests/postgres-shared.ts
function buildRuntimeRequestTableNames() {
  return buildRuntimeRelationNames({
    runtimeRequests: "runtime_requests"
  });
}

// src/domain/threads/requests/ordering-key.ts
import { createHash } from "node:crypto";
function keyParts(kind, payload) {
  switch (kind) {
    case "a2a_message":
      return ["session", payload.toSessionId];
    case "telegram_message":
    case "telegram_reaction": {
      const message = payload;
      return ["conversation", "telegram", message.connectorKey, message.externalConversationId];
    }
    case "whatsapp_message":
    case "whatsapp_reaction": {
      const message = payload;
      return ["conversation", "whatsapp", message.connectorKey, message.externalConversationId];
    }
    case "discord_message": {
      const message = payload;
      return ["conversation", "discord", message.connectorKey, message.externalConversationId];
    }
    case "live_voice_delegation": {
      const voice = payload;
      return ["session", voice.sessionId];
    }
    case "tui_input": {
      const input = payload;
      return input.threadId ? ["thread", input.threadId] : ["identity-main", input.identityId ?? "anonymous"];
    }
    case "create_branch_session":
    case "create_subagent_session":
      return ["session", payload.sessionId];
    case "resolve_main_session_thread": {
      const resolve = payload;
      return ["identity-main", resolve.identityId ?? "anonymous", resolve.agentKey ?? "default"];
    }
    case "resolve_thread_run_config":
    case "abort_thread":
    case "compact_thread":
    case "update_thread":
      return ["thread", payload.threadId];
    case "reset_session": {
      const reset = payload;
      if (reset.sessionId) return ["session", reset.sessionId];
      if (reset.threadId) return ["thread", reset.threadId];
      if (reset.connectorKey && reset.externalConversationId) {
        return ["conversation", reset.source, reset.connectorKey, reset.externalConversationId];
      }
      return ["identity-main", reset.identityId ?? "anonymous", reset.agentKey ?? "default"];
    }
    case "compact_session":
      return ["session", payload.sessionId];
  }
}
function deriveRuntimeRequestOrderingKey(input) {
  const parts = keyParts(input.kind, input.payload);
  if (parts.some((part) => !part)) {
    throw new Error(`Runtime request ${input.kind} cannot derive a non-empty ordering key.`);
  }
  return `v1:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
}

// src/domain/threads/requests/types.ts
var RUNTIME_REQUEST_STATUSES = [
  "pending",
  "running",
  "completed",
  "failed"
];
var RUNTIME_REQUEST_KINDS = [
  "a2a_message",
  "telegram_message",
  "telegram_reaction",
  "whatsapp_message",
  "whatsapp_reaction",
  "discord_message",
  "live_voice_delegation",
  "tui_input",
  "create_branch_session",
  "create_subagent_session",
  "resolve_main_session_thread",
  "resolve_thread_run_config",
  "reset_session",
  "abort_thread",
  "compact_thread",
  "compact_session",
  "update_thread"
];

// src/domain/threads/requests/postgres-schema.ts
async function ensurePostgresRuntimeRequestSchema(pool) {
  const tables3 = buildRuntimeRequestTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.runtimeRequests} (
      id UUID PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      payload JSONB NOT NULL,
      ordering_key TEXT NOT NULL,
      idempotency_key TEXT,
      result JSONB,
      error TEXT,
      claimed_at TIMESTAMPTZ,
      claim_token UUID,
      claim_expires_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ${tables3.runtimeRequests} ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
  await pool.query(`ALTER TABLE ${tables3.runtimeRequests} ADD COLUMN IF NOT EXISTS ordering_key TEXT`);
  await pool.query(`ALTER TABLE ${tables3.runtimeRequests} ADD COLUMN IF NOT EXISTS claim_token UUID`);
  await pool.query(`ALTER TABLE ${tables3.runtimeRequests} ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ`);
  await pool.query(`DELETE FROM ${tables3.runtimeRequests} WHERE kind = 'create_worker_session'`);
  const parseMigrationPayload = (row) => {
    const value = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
    if (!isJsonObject(value)) {
      throw new Error(`Cannot migrate runtime request ${String(row.id)} with a non-object payload.`);
    }
    return value;
  };
  const legacyCreates = await pool.query(`
    SELECT id, kind, payload
    FROM ${tables3.runtimeRequests}
    WHERE kind IN ('create_branch_session', 'create_subagent_session')
  `);
  for (const row of legacyCreates.rows) {
    const payload = parseMigrationPayload(row);
    const prefix = row.kind === "create_branch_session" ? "branch" : "subagent";
    const sessionId = typeof payload.sessionId === "string" && payload.sessionId.trim() ? payload.sessionId : `${prefix}-session:${String(row.id)}`;
    const threadId = typeof payload.threadId === "string" && payload.threadId.trim() ? payload.threadId : `${prefix}-thread:${String(row.id)}`;
    await pool.query(`UPDATE ${tables3.runtimeRequests} SET payload = $2::jsonb WHERE id = $1`, [
      row.id,
      JSON.stringify({ ...payload, sessionId, threadId })
    ]);
  }
  const liveVoiceTable = await pool.query(`
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'runtime' AND table_name = 'live_voice_turns'
    LIMIT 1
  `);
  const legacyVoiceRequests = await pool.query(`
    SELECT id, payload
    FROM ${tables3.runtimeRequests}
    WHERE kind = 'live_voice_delegation'
  `);
  for (const row of legacyVoiceRequests.rows) {
    const payload = parseMigrationPayload(row);
    if (typeof payload.sessionId === "string" && payload.sessionId.trim()) continue;
    let sessionId;
    if (liveVoiceTable.rows.length > 0 && typeof payload.liveVoiceTurnId === "string") {
      const turn = await pool.query(
        `SELECT session_id FROM "runtime"."live_voice_turns" WHERE id::text = $1`,
        [payload.liveVoiceTurnId]
      );
      const value = turn.rows[0]?.session_id;
      if (typeof value === "string" && value.trim()) sessionId = value;
    }
    if (sessionId) {
      await pool.query(`UPDATE ${tables3.runtimeRequests} SET payload = $2::jsonb WHERE id = $1`, [
        row.id,
        JSON.stringify({ ...payload, sessionId })
      ]);
    } else {
      await pool.query(`DELETE FROM ${tables3.runtimeRequests} WHERE id = $1`, [row.id]);
    }
  }
  await pool.query(`
    UPDATE ${tables3.runtimeRequests}
    SET status = 'failed',
        error = 'Legacy running runtime request was interrupted by schema migration and cannot be replayed safely.',
        claim_token = NULL,
        claim_expires_at = NULL,
        finished_at = NOW(),
        updated_at = NOW()
    WHERE status = 'running'
  `);
  const missingOrderingKeys = await pool.query(`
    SELECT id, kind, payload
    FROM ${tables3.runtimeRequests}
    WHERE ordering_key IS NULL
    ORDER BY created_at, id
  `);
  for (const row of missingOrderingKeys.rows) {
    if (typeof row.kind !== "string" || !RUNTIME_REQUEST_KINDS.includes(row.kind)) {
      throw new Error(`Cannot migrate runtime request ${String(row.id)} with unsupported kind ${String(row.kind)}.`);
    }
    const kind = row.kind;
    const orderingKey = deriveRuntimeRequestOrderingKey({
      kind,
      payload: row.payload
    });
    await pool.query(`
      UPDATE ${tables3.runtimeRequests}
      SET ordering_key = $2
      WHERE id = $1 AND ordering_key IS NULL
    `, [row.id, orderingKey]);
  }
  await pool.query(`ALTER TABLE ${tables3.runtimeRequests} ALTER COLUMN ordering_key SET NOT NULL`);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_runtime_requests_idempotency_idx`)}
    ON ${tables3.runtimeRequests} (idempotency_key)
  `);
  await pool.query(`
    DROP INDEX IF EXISTS ${quoteIdentifier(tables3.prefix)}.${quoteIdentifier(`${tables3.prefix}_runtime_requests_claimable_idx`)}
  `);
  await pool.query(`DROP INDEX IF EXISTS ${quoteIdentifier(tables3.prefix)}.${quoteIdentifier(`${tables3.prefix}_runtime_requests_pending_idx`)}`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_runtime_requests_settled_idx`)}
    ON ${tables3.runtimeRequests} (status, finished_at, id)
    WHERE status IN ('completed', 'failed')
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_runtime_requests_running_key_idx`)}
    ON ${tables3.runtimeRequests} (ordering_key)
    WHERE status = 'running'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_runtime_requests_unsettled_key_idx`)}
    ON ${tables3.runtimeRequests} (ordering_key, created_at, id)
    WHERE status IN ('pending', 'running')
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_runtime_requests_unsettled_fifo_idx`)}
    ON ${tables3.runtimeRequests} (created_at, id)
    WHERE status IN ('pending', 'running')
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.runtimeRequests}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_runtime_requests_kind_check`)}
    CHECK (kind IN (${RUNTIME_REQUEST_KINDS.map((kind) => `'${kind}'`).join(", ")}))
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.runtimeRequests}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_runtime_requests_ordering_key_check`)}
    CHECK (ordering_key LIKE 'v1:%')
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.runtimeRequests}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_runtime_requests_lifecycle_check`)}
    CHECK (
      (
        status = 'pending'
        AND claimed_at IS NULL
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND finished_at IS NULL
      ) OR (
        status = 'running'
        AND claimed_at IS NOT NULL
        AND claim_token IS NOT NULL
        AND claim_expires_at IS NOT NULL
        AND finished_at IS NULL
      ) OR (
        status IN ('completed', 'failed')
        AND claim_token IS NULL
        AND claim_expires_at IS NULL
        AND finished_at IS NOT NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.runtimeRequests}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_runtime_requests_status_check`)}
    CHECK (status IN (${RUNTIME_REQUEST_STATUSES.map((status) => `'${status}'`).join(", ")}))
  `);
}

// src/domain/watches/postgres-shared.ts
function buildWatchTableNames() {
  return buildRuntimeRelationNames({
    watches: "watches",
    watchRuns: "watch_runs",
    watchEvents: "watch_events"
  });
}

// src/domain/threads/runtime/postgres-readonly.ts
var READONLY_SESSION_VIEW_DEFINITIONS = {
  agentSessions: "agent_sessions",
  todos: "todos",
  runtimeConfig: "runtime_config",
  threads: "threads",
  messages: "messages",
  messagesRaw: "messages_raw",
  toolResults: "tool_results",
  inputs: "inputs",
  runs: "runs",
  prompts: "prompts",
  agentPairings: "agent_pairings",
  agentSkills: "agent_skills",
  subagentHistory: "subagent_history",
  scheduledTasks: "scheduled_tasks",
  scheduledTaskRuns: "scheduled_task_runs",
  watches: "watches",
  watchRuns: "watch_runs",
  watchEvents: "watch_events",
  emailAccounts: "email_accounts",
  emailAllowedRecipients: "email_allowed_recipients",
  emailRoutes: "email_routes",
  emailMessages: "email_messages",
  emailMessageRecipients: "email_message_recipients",
  emailAttachments: "email_attachments"
};
var READONLY_SESSION_VIEW_BASENAMES = Object.freeze(Object.values(READONLY_SESSION_VIEW_DEFINITIONS));
async function ensureReadonlySessionQuerySchema(options) {
  const tables3 = buildThreadRuntimeTableNames();
  const agentTables = buildAgentTableNames();
  const identityTables = buildIdentityTableNames();
  const sessionTables = buildSessionTableNames();
  const scheduledTaskTables = buildScheduledTaskTableNames();
  const watchTables = buildWatchTableNames();
  const emailTables = buildEmailTableNames();
  const environmentTables = buildExecutionEnvironmentTableNames();
  const { prefix: _sessionSchema, ...views } = buildSessionRelationNames(READONLY_SESSION_VIEW_DEFINITIONS);
  const messageTextSql = `
    CASE
      WHEN jsonb_typeof(m.message->'content') = 'string' THEN m.message->>'content'
      WHEN jsonb_typeof(m.message->'content') = 'array' THEN (
        SELECT string_agg(block->>'text', E'\\n')
        FROM jsonb_array_elements(m.message->'content') AS block
        WHERE block->>'type' = 'text'
      )
      ELSE NULL
    END
  `;
  const inputTextSql = `
    CASE
      WHEN jsonb_typeof(i.message->'content') = 'string' THEN i.message->>'content'
      WHEN jsonb_typeof(i.message->'content') = 'array' THEN (
        SELECT string_agg(block->>'text', E'\\n')
        FROM jsonb_array_elements(i.message->'content') AS block
        WHERE block->>'type' = 'text'
      )
      ELSE NULL
    END
  `;
  const sessionScopeSql = `t.session_id = current_setting('runtime.session_id', true)`;
  const activeSessionSql = `
    SELECT *
    FROM ${sessionTables.sessions}
    WHERE id = current_setting('runtime.session_id', true)
    LIMIT 1
  `;
  await options.queryable.query(`
    CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(RUNTIME_SCHEMA)};
    CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SESSION_SCHEMA)};

    DROP VIEW IF EXISTS ${views.watchEvents};
    DROP VIEW IF EXISTS ${views.watchRuns};
    DROP VIEW IF EXISTS ${views.watches};
    DROP VIEW IF EXISTS ${views.emailAttachments};
    DROP VIEW IF EXISTS ${views.emailMessageRecipients};
    DROP VIEW IF EXISTS ${views.emailMessages};
    DROP VIEW IF EXISTS ${views.emailRoutes};
    DROP VIEW IF EXISTS ${views.emailAllowedRecipients};
    DROP VIEW IF EXISTS ${views.emailAccounts};
    DROP VIEW IF EXISTS ${quoteQualifiedIdentifier(SESSION_SCHEMA, "agent_telepathy_devices")};
    DROP VIEW IF EXISTS ${quoteQualifiedIdentifier(SESSION_SCHEMA, "agent_prompts")};
    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(RUNTIME_SCHEMA, "runtime_telepathy_devices_agent_idx")};
    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(RUNTIME_SCHEMA, "runtime_telepathy_devices_connected_idx")};
    DROP TABLE IF EXISTS ${quoteQualifiedIdentifier(RUNTIME_SCHEMA, "telepathy_devices")} CASCADE;
    DROP VIEW IF EXISTS ${views.agentPairings};
    DROP VIEW IF EXISTS ${views.prompts};
    DROP VIEW IF EXISTS ${views.agentSkills};
    DROP VIEW IF EXISTS ${views.subagentHistory};
    DROP VIEW IF EXISTS ${views.scheduledTaskRuns};
    DROP VIEW IF EXISTS ${views.scheduledTasks};
    DROP VIEW IF EXISTS ${views.toolResults};
    DROP VIEW IF EXISTS ${views.messages};
    DROP VIEW IF EXISTS ${views.messagesRaw};
    DROP VIEW IF EXISTS ${views.inputs};
    DROP VIEW IF EXISTS ${views.runs};
    DROP VIEW IF EXISTS ${views.todos};
    DROP VIEW IF EXISTS ${views.runtimeConfig};
    DROP VIEW IF EXISTS ${views.threads};
    DROP VIEW IF EXISTS ${views.agentSessions};

    CREATE VIEW ${views.agentSessions}
    WITH (security_barrier = true) AS
    SELECT
      s.id,
      s.agent_key,
      s.kind,
      s.current_thread_id,
      s.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      s.alias,
      s.display_name,
      s.metadata,
      s.created_at,
      s.updated_at
    FROM (${activeSessionSql}) AS s
    LEFT JOIN ${identityTables.identities} AS creator
      ON creator.id = s.created_by_identity_id;

    CREATE VIEW ${views.todos}
    WITH (security_barrier = true) AS
    SELECT
      todo.session_id,
      todo.items,
      jsonb_array_length(todo.items)::INTEGER AS item_count,
      todo.items_hash,
      todo.created_at,
      todo.updated_at
    FROM ${sessionTables.sessionTodos} AS todo
    WHERE todo.session_id = current_setting('runtime.session_id', true);

    CREATE VIEW ${views.runtimeConfig}
    WITH (security_barrier = true) AS
    SELECT
      config.session_id,
      session.agent_key,
      session.kind AS session_kind,
      config.model,
      config.thinking,
      config.thinking_configured,
      config.inference_projection,
      config.pending_wake_at,
      config.created_at,
      config.updated_at
    FROM ${sessionTables.sessionRuntimeConfig} AS config
    INNER JOIN ${sessionTables.sessions} AS session ON session.id = config.session_id
    WHERE config.session_id = current_setting('runtime.session_id', true);

    CREATE VIEW ${views.threads}
    WITH (security_barrier = true) AS
    SELECT
      t.id,
      t.session_id,
      t.replaces_thread_id,
      session.agent_key,
      session.kind AS session_kind,
      t.created_at,
      t.updated_at,
      COALESCE((
        SELECT COUNT(*)::INTEGER
        FROM ${tables3.messages} AS m
        WHERE m.thread_id = t.id
      ), 0) AS message_count,
      COALESCE((
        SELECT COUNT(*)::INTEGER
        FROM ${tables3.inputs} AS i
        WHERE i.thread_id = t.id
          AND i.applied_at IS NULL
          AND i.discarded_at IS NULL
      ), 0) AS pending_input_count,
      (
        SELECT MAX(m.created_at)
        FROM ${tables3.messages} AS m
        WHERE m.thread_id = t.id
      ) AS last_message_at
    FROM ${tables3.threads} AS t
    INNER JOIN ${sessionTables.sessions} AS session ON session.id = t.session_id
    WHERE ${sessionScopeSql};

    CREATE VIEW ${views.messagesRaw}
    WITH (security_barrier = true) AS
    SELECT
      m.id,
      m.thread_id,
      m.sequence,
      m.origin,
      m.source,
      m.channel_id,
      m.external_message_id,
      m.actor_id,
      m.identity_id,
      speaker.handle AS identity_handle,
      m.run_id,
      m.created_at,
      m.message,
      m.message->>'role' AS role,
      COALESCE(m.message->>'toolName', NULL) AS tool_name,
      ${messageTextSql} AS text,
      CASE
        WHEN jsonb_typeof(m.message->'content') = 'array' THEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements(m.message->'content') AS block
          WHERE block->>'type' = 'image'
        )
        ELSE FALSE
      END AS has_images
    FROM ${tables3.messages} AS m
    INNER JOIN ${tables3.threads} AS t ON t.id = m.thread_id
    LEFT JOIN ${identityTables.identities} AS speaker ON speaker.id = m.identity_id
    WHERE ${sessionScopeSql};

    CREATE VIEW ${views.messages}
    WITH (security_barrier = true) AS
    SELECT
      raw.id,
      raw.thread_id,
      raw.sequence,
      raw.origin,
      raw.source,
      raw.channel_id,
      raw.external_message_id,
      raw.actor_id,
      raw.identity_id,
      raw.identity_handle,
      raw.run_id,
      raw.created_at,
      raw.role,
      CASE
        WHEN raw.text IS NOT NULL THEN raw.text
        WHEN raw.role = 'assistant' AND jsonb_typeof(raw.message->'content') = 'array' THEN (
          SELECT string_agg('[tool call: ' || COALESCE(block->>'name', 'unknown') || ']', E'\\n')
          FROM jsonb_array_elements(raw.message->'content') AS block
          WHERE block->>'type' = 'toolCall'
        )
        ELSE NULL
      END AS text,
      raw.has_images
    FROM ${views.messagesRaw} AS raw
    WHERE raw.role IN ('user', 'assistant');

    CREATE VIEW ${views.toolResults}
    WITH (security_barrier = true) AS
    SELECT
      raw.id,
      raw.thread_id,
      raw.sequence,
      raw.source,
      raw.run_id,
      raw.created_at,
      COALESCE(raw.tool_name, 'unknown') AS tool_name,
      COALESCE((raw.message->>'isError')::BOOLEAN, false) AS is_error,
      CASE
        WHEN raw.text IS NULL OR btrim(raw.text) = '' THEN '[tool result: ' || COALESCE(raw.tool_name, 'unknown') || ']'
        ELSE left(raw.text, 500)
      END AS result_preview,
      octet_length(convert_to(COALESCE(raw.text, ''), 'utf8'))::INTEGER AS result_bytes,
      raw.has_images
    FROM ${views.messagesRaw} AS raw
    WHERE raw.role = 'toolResult';

    CREATE VIEW ${views.inputs}
    WITH (security_barrier = true) AS
    SELECT
      i.id,
      i.thread_id,
      i.input_order,
      i.delivery_mode,
      i.source,
      i.channel_id,
      i.external_message_id,
      i.actor_id,
      i.identity_id,
      speaker.handle AS identity_handle,
      i.created_at,
      i.message,
      i.message->>'role' AS role,
      ${inputTextSql} AS text,
      CASE
        WHEN jsonb_typeof(i.message->'content') = 'array' THEN EXISTS (
          SELECT 1
          FROM jsonb_array_elements(i.message->'content') AS block
          WHERE block->>'type' = 'image'
        )
        ELSE FALSE
      END AS has_images
    FROM ${tables3.inputs} AS i
    INNER JOIN ${tables3.threads} AS t ON t.id = i.thread_id
    LEFT JOIN ${identityTables.identities} AS speaker ON speaker.id = i.identity_id
    WHERE ${sessionScopeSql}
      AND i.applied_at IS NULL
      AND i.discarded_at IS NULL;

    CREATE VIEW ${views.runs}
    WITH (security_barrier = true) AS
    SELECT
      r.id,
      r.thread_id,
      r.status,
      r.started_at,
      r.finished_at,
      r.abort_requested_at,
      r.abort_reason,
      r.error
    FROM ${tables3.runs} AS r
    INNER JOIN ${tables3.threads} AS t ON t.id = r.thread_id
    WHERE ${sessionScopeSql};

    CREATE VIEW ${views.prompts}
    WITH (security_barrier = true) AS
    SELECT
      prompt.session_id,
      prompt.slug,
      prompt.content,
      octet_length(convert_to(prompt.content, 'utf8'))::INTEGER AS content_bytes,
      prompt.created_at,
      prompt.updated_at
    FROM ${sessionTables.sessionPrompts} AS prompt
    INNER JOIN (${activeSessionSql}) AS active_session
      ON active_session.id = prompt.session_id;

    CREATE VIEW ${views.agentPairings}
    WITH (security_barrier = true) AS
    SELECT
      pairing.agent_key,
      pairing.identity_id,
      identity_row.handle AS identity_handle,
      pairing.metadata,
      pairing.created_at,
      pairing.updated_at
    FROM ${agentTables.agentPairings} AS pairing
    INNER JOIN ${identityTables.identities} AS identity_row ON identity_row.id = pairing.identity_id
    WHERE pairing.agent_key = current_setting('runtime.agent_key', true);

    CREATE VIEW ${views.agentSkills}
    WITH (security_barrier = true) AS
    SELECT
      skill.agent_key,
      skill.skill_key,
      skill.description,
      skill.content,
      skill.tags,
      skill.agent_editable,
      skill.last_loaded_at,
      COALESCE(skill.load_count, 0) AS load_count,
      octet_length(convert_to(skill.content, 'utf8'))::INTEGER AS content_bytes,
      skill.created_at,
      skill.updated_at
    FROM ${agentTables.agentSkills} AS skill
    WHERE skill.agent_key = current_setting('runtime.agent_key', true)
      AND (
        COALESCE(current_setting('runtime.skill_policy', true), 'all_agent') = 'all_agent'
        OR (
          current_setting('runtime.skill_policy', true) = 'allowlist'
          AND STRPOS(',' || COALESCE(current_setting('runtime.skill_allowlist', true), '') || ',', ',' || skill.skill_key || ',') > 0
        )
      );

    CREATE VIEW ${views.subagentHistory}
    WITH (security_barrier = true) AS
    SELECT
      subagent.id AS session_id,
      subagent.agent_key,
      subagent.current_thread_id,
      subagent.metadata->'subagent'->>'parentSessionId' AS parent_session_id,
      subagent.metadata->'subagent'->'profile'->>'slug' AS profile,
      subagent.metadata->'subagent'->>'execution' AS execution,
      subagent.metadata->'subagent'->>'environmentId' AS environment_id,
      environment.state AS environment_state,
      left(COALESCE(subagent.metadata->'subagent'->>'task', ''), 240) AS task_preview,
      subagent.created_at AS started_at,
      subagent.updated_at AS session_updated_at,
      thread_summary.thread_updated_at,
      thread_summary.last_message_at,
      GREATEST(
        subagent.created_at,
        subagent.updated_at,
        COALESCE(thread_summary.thread_updated_at, subagent.updated_at),
        COALESCE(thread_summary.last_message_at, subagent.updated_at),
        COALESCE(environment.updated_at, subagent.updated_at),
        COALESCE(binding.updated_at, subagent.updated_at)
      ) AS last_activity_at,
      COALESCE(thread_summary.message_count, 0)::INTEGER AS message_count,
      COALESCE(thread_summary.pending_input_count, 0)::INTEGER AS pending_input_count,
      binding.alias AS environment_alias,
      binding.created_at AS environment_bound_at
    FROM ${sessionTables.sessions} AS subagent
    INNER JOIN (${activeSessionSql}) AS active_session
      ON active_session.id = subagent.metadata->'subagent'->>'parentSessionId'
     AND active_session.agent_key = subagent.agent_key
    LEFT JOIN ${environmentTables.executionEnvironments} AS environment
      ON environment.id = subagent.metadata->'subagent'->>'environmentId'
     AND environment.agent_key = subagent.agent_key
     AND environment.created_by_session_id = active_session.id
    LEFT JOIN ${environmentTables.sessionEnvironmentBindings} AS binding
      ON binding.session_id = subagent.id
     AND binding.environment_id = environment.id
    LEFT JOIN LATERAL (
      SELECT
        (
          SELECT MAX(t.updated_at)
          FROM ${tables3.threads} AS t
          WHERE t.session_id = subagent.id
        ) AS thread_updated_at,
        (
          SELECT MAX(m.created_at)
          FROM ${tables3.messages} AS m
          INNER JOIN ${tables3.threads} AS t ON t.id = m.thread_id
          WHERE t.session_id = subagent.id
        ) AS last_message_at,
        (
          SELECT COUNT(*)::INTEGER
          FROM ${tables3.messages} AS m
          INNER JOIN ${tables3.threads} AS t ON t.id = m.thread_id
          WHERE t.session_id = subagent.id
        ) AS message_count,
        (
          SELECT COUNT(*)::INTEGER
          FROM ${tables3.inputs} AS i
          INNER JOIN ${tables3.threads} AS t ON t.id = i.thread_id
          WHERE t.session_id = subagent.id
            AND i.applied_at IS NULL
            AND i.discarded_at IS NULL
        ) AS pending_input_count
    ) AS thread_summary ON TRUE
    WHERE subagent.kind = 'subagent'
      AND subagent.agent_key = current_setting('runtime.agent_key', true)
      AND subagent.metadata->'subagent'->>'parentSessionId' = current_setting('runtime.session_id', true);

    CREATE VIEW ${views.scheduledTasks}
    WITH (security_barrier = true) AS
    SELECT
      st.id,
      st.session_id,
      st.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      st.created_from_message_id,
      st.title,
      st.instruction,
      st.schedule_kind,
      st.run_at,
      st.cron_expr,
      st.timezone,
      active_session.current_thread_id AS resolved_thread_id,
      st.enabled,
      CASE
        WHEN st.cancelled_at IS NOT NULL THEN 'cancelled'
        WHEN EXISTS (
          SELECT 1
          FROM ${scheduledTaskTables.scheduledTaskRuns} AS active_run
          WHERE active_run.task_id = st.id
            AND active_run.status IN ('pending', 'claimed', 'running')
        ) THEN 'running'
        WHEN st.completed_at IS NOT NULL AND (
          SELECT task_run.status
          FROM ${scheduledTaskTables.scheduledTaskRuns} AS task_run
          WHERE task_run.task_id = st.id
          ORDER BY task_run.created_at DESC, task_run.id ASC
          LIMIT 1
        ) = 'failed' THEN 'failed'
        WHEN st.completed_at IS NOT NULL THEN 'completed'
        ELSE 'scheduled'
      END AS status,
      st.next_fire_at,
      st.completed_at,
      st.cancelled_at,
      st.created_at,
      st.updated_at
    FROM ${scheduledTaskTables.scheduledTasks} AS st
    INNER JOIN (${activeSessionSql}) AS active_session ON active_session.id = st.session_id
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = st.created_by_identity_id;

    CREATE VIEW ${views.scheduledTaskRuns}
    WITH (security_barrier = true) AS
    SELECT
      run.id,
      run.task_id,
      run.session_id,
      run.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      run.resolved_thread_id,
      run.scheduled_for,
      run.status,
      run.thread_input_id,
      run.thread_run_id,
      run.error,
      run.created_at,
      run.started_at,
      run.finished_at
    FROM ${scheduledTaskTables.scheduledTaskRuns} AS run
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = run.created_by_identity_id
    WHERE run.session_id = current_setting('runtime.session_id', true);

    CREATE VIEW ${views.watches}
    WITH (security_barrier = true) AS
    SELECT
      watch.id,
      watch.session_id,
      watch.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      watch.title,
      watch.interval_minutes,
      active_session.current_thread_id AS resolved_thread_id,
      watch.source_config,
      watch.detector_config,
      watch.enabled,
      watch.next_poll_at,
      watch.claimed_at,
      watch.claimed_by,
      watch.claim_expires_at,
      watch.cooldown_until,
      watch.last_error,
      watch.state,
      watch.disabled_at,
      watch.created_at,
      watch.updated_at
    FROM ${watchTables.watches} AS watch
    INNER JOIN (${activeSessionSql}) AS active_session ON active_session.id = watch.session_id
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = watch.created_by_identity_id;

    CREATE VIEW ${views.watchRuns}
    WITH (security_barrier = true) AS
    SELECT
      run.id,
      run.watch_id,
      run.session_id,
      run.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      run.scheduled_for,
      run.status,
      run.resolved_thread_id,
      run.emitted_event_id,
      run.error,
      run.created_at,
      run.started_at,
      run.finished_at
    FROM ${watchTables.watchRuns} AS run
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = run.created_by_identity_id
    WHERE run.session_id = current_setting('runtime.session_id', true);

    CREATE VIEW ${views.watchEvents}
    WITH (security_barrier = true) AS
    SELECT
      event.id,
      event.watch_id,
      event.session_id,
      event.created_by_identity_id,
      creator.handle AS created_by_identity_handle,
      event.resolved_thread_id,
      event.event_kind,
      event.summary,
      event.dedupe_key,
      event.payload,
      event.created_at
    FROM ${watchTables.watchEvents} AS event
    LEFT JOIN ${identityTables.identities} AS creator ON creator.id = event.created_by_identity_id
    WHERE event.session_id = current_setting('runtime.session_id', true);

    CREATE VIEW ${views.emailAccounts}
    WITH (security_barrier = true) AS
    SELECT DISTINCT
      email_account.agent_key,
      email_account.account_key,
      email_account.from_address,
      email_account.from_name,
      email_account.mailboxes,
      email_account.enabled,
      email_account.created_at,
      email_account.updated_at
    FROM ${emailTables.emailAccounts} AS email_account
    INNER JOIN (${activeSessionSql}) AS active_session
      ON active_session.agent_key = email_account.agent_key
    LEFT JOIN ${emailTables.emailRoutes} AS visible_route
      ON visible_route.agent_key = email_account.agent_key
     AND visible_route.account_key = email_account.account_key
     AND visible_route.session_id = active_session.id
    LEFT JOIN ${emailTables.emailRoutes} AS account_route
      ON account_route.agent_key = email_account.agent_key
     AND account_route.account_key = email_account.account_key
     AND account_route.mailbox IS NULL
    WHERE visible_route.id IS NOT NULL
      OR (active_session.kind = 'main' AND account_route.id IS NULL);

    CREATE VIEW ${views.emailAllowedRecipients}
    WITH (security_barrier = true) AS
    SELECT DISTINCT
      recipient.agent_key,
      recipient.account_key,
      recipient.address,
      recipient.created_at
    FROM ${emailTables.emailAllowedRecipients} AS recipient
    INNER JOIN (${activeSessionSql}) AS active_session
      ON active_session.agent_key = recipient.agent_key
    LEFT JOIN ${emailTables.emailRoutes} AS visible_route
      ON visible_route.agent_key = recipient.agent_key
     AND visible_route.account_key = recipient.account_key
     AND visible_route.session_id = active_session.id
    LEFT JOIN ${emailTables.emailRoutes} AS account_route
      ON account_route.agent_key = recipient.agent_key
     AND account_route.account_key = recipient.account_key
     AND account_route.mailbox IS NULL
    WHERE visible_route.id IS NOT NULL
      OR (active_session.kind = 'main' AND account_route.id IS NULL);

    CREATE VIEW ${views.emailRoutes}
    WITH (security_barrier = true) AS
    SELECT
      route.id,
      route.agent_key,
      route.account_key,
      route.mailbox,
      route.session_id,
      route.created_at,
      route.updated_at
    FROM ${emailTables.emailRoutes} AS route
    INNER JOIN (${activeSessionSql}) AS active_session
      ON active_session.id = route.session_id;

    CREATE VIEW ${views.emailMessages}
    WITH (security_barrier = true) AS
    SELECT
      message.id,
      message.agent_key,
      message.account_key,
      message.session_id,
      message.route_id,
      message.direction,
      message.mailbox,
      message.uid,
      message.message_id_header,
      message.in_reply_to,
      message.references_header,
      message.thread_key,
      message.subject,
      message.from_name,
      message.from_address,
      message.reply_to_address,
      message.sent_at,
      message.received_at,
      message.body_text,
      message.body_excerpt,
      message.authentication_results,
      message.auth_spf,
      message.auth_dkim,
      message.auth_dmarc,
      message.auth_summary,
      message.has_attachments,
      message.source_delivery_id,
      message.created_at
    FROM ${emailTables.emailMessages} AS message
    INNER JOIN (${activeSessionSql}) AS active_session
      ON active_session.agent_key = message.agent_key
    WHERE message.session_id = active_session.id
      OR (message.session_id IS NULL AND active_session.kind = 'main');

    CREATE VIEW ${views.emailMessageRecipients}
    WITH (security_barrier = true) AS
    SELECT
      recipient.id,
      recipient.message_id,
      message.agent_key,
      message.account_key,
      message.session_id,
      message.route_id,
      recipient.role,
      recipient.address,
      recipient.name,
      recipient.created_at
    FROM ${emailTables.emailMessageRecipients} AS recipient
    INNER JOIN ${emailTables.emailMessages} AS message ON message.id = recipient.message_id
    INNER JOIN (${activeSessionSql}) AS active_session
      ON active_session.agent_key = message.agent_key
    WHERE message.session_id = active_session.id
      OR (message.session_id IS NULL AND active_session.kind = 'main');

    CREATE VIEW ${views.emailAttachments}
    WITH (security_barrier = true) AS
    SELECT
      attachment.id,
      attachment.message_id,
      message.agent_key,
      message.account_key,
      message.session_id,
      message.route_id,
      attachment.filename,
      attachment.mime_type,
      attachment.size_bytes,
      attachment.local_path,
      attachment.content_id,
      attachment.storage_status,
      attachment.storage_reason,
      attachment.created_at
    FROM ${emailTables.emailAttachments} AS attachment
    INNER JOIN ${emailTables.emailMessages} AS message ON message.id = attachment.message_id
    INNER JOIN (${activeSessionSql}) AS active_session
      ON active_session.agent_key = message.agent_key
    WHERE message.session_id = active_session.id
      OR (message.session_id IS NULL AND active_session.kind = 'main');
  `);
  return views;
}

// src/domain/threads/runtime/postgres-schema.ts
var REDACTED_SET_ENV_VALUE = "[redacted]";
var THREAD_RUNTIME_MIGRATIONS_TABLE = `${quoteIdentifier(RUNTIME_SCHEMA)}.${quoteIdentifier("thread_runtime_migrations")}`;
var SET_ENV_VALUE_ARGUMENT_REDACTION_MIGRATION = "set_env_value_tool_call_argument_redaction_2026_05_22";
var TYPED_COMPACTION_CHECKPOINT_MIGRATION = "typed_compaction_checkpoints_2026_08_24";
var LEGACY_THREAD_CONTEXT_COLUMN = "context";
var LEGACY_THREAD_SCALAR_COLUMNS = ["system_prompt", "max_turns", "temperature"];
function isJsonRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function redactSetEnvValueToolCallsInMessage(message) {
  if (!isJsonRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
    return { message, redacted: false };
  }
  let redacted = false;
  const content = message.content.map((block) => {
    if (!isJsonRecord(block) || block.type !== "toolCall" || block.name !== "set_env_value") {
      return block;
    }
    const args = block.arguments;
    if (!isJsonRecord(args) || !Object.prototype.hasOwnProperty.call(args, "value") || args.value === REDACTED_SET_ENV_VALUE) {
      return block;
    }
    redacted = true;
    return {
      ...block,
      arguments: {
        ...args,
        value: REDACTED_SET_ENV_VALUE
      }
    };
  });
  if (!redacted) {
    return { message, redacted: false };
  }
  return {
    message: {
      ...message,
      content
    },
    redacted: true
  };
}
async function ensureThreadRuntimeMigrationTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${THREAD_RUNTIME_MIGRATIONS_TABLE} (
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
async function hasThreadRuntimeMigration(pool, migrationKey) {
  const result = await pool.query(`
    SELECT 1
    FROM ${THREAD_RUNTIME_MIGRATIONS_TABLE}
    WHERE migration_key = $1
    LIMIT 1
  `, [migrationKey]);
  return result.rows.length > 0;
}
async function markThreadRuntimeMigration(pool, migrationKey) {
  await pool.query(`
    INSERT INTO ${THREAD_RUNTIME_MIGRATIONS_TABLE} (migration_key)
    VALUES ($1)
    ON CONFLICT (migration_key) DO NOTHING
  `, [migrationKey]);
}
async function redactLegacySetEnvValueToolCallArguments(pool, tables3) {
  if (await hasThreadRuntimeMigration(pool, SET_ENV_VALUE_ARGUMENT_REDACTION_MIGRATION)) {
    return;
  }
  const result = await pool.query(`
    SELECT id, message
    FROM ${tables3.messages}
    WHERE message->>'role' = 'assistant'
      AND message->>'content' LIKE '%set_env_value%'
      AND message->>'content' LIKE '%value%'
  `);
  for (const row of result.rows) {
    if (!isJsonRecord(row) || typeof row.id !== "string") {
      continue;
    }
    const redacted = redactSetEnvValueToolCallsInMessage(row.message);
    if (!redacted.redacted) {
      continue;
    }
    await pool.query(`
      UPDATE ${tables3.messages}
      SET message = $2::jsonb
      WHERE id = $1
    `, [
      row.id,
      JSON.stringify(redacted.message)
    ]);
  }
  await markThreadRuntimeMigration(pool, SET_ENV_VALUE_ARGUMENT_REDACTION_MIGRATION);
}
async function migrateTypedCompactionCheckpoints(pool, tables3) {
  if (await hasThreadRuntimeMigration(pool, TYPED_COMPACTION_CHECKPOINT_MIGRATION)) {
    return;
  }
  await pool.query(`
    UPDATE ${tables3.messages}
    SET compacted_through_sequence = (metadata ->> 'compactedUpToSequence')::BIGINT,
        metadata = metadata - 'compactedUpToSequence'
    WHERE source = 'compact'
      AND metadata ->> 'kind' = 'compact_boundary'
      AND metadata ->> 'compactedUpToSequence' IS NOT NULL
  `);
  await markThreadRuntimeMigration(pool, TYPED_COMPACTION_CHECKPOINT_MIGRATION);
}
function buildValidCompactionCheckpointSql() {
  return `
    compacted_through_sequence IS NOT NULL
    AND compacted_through_sequence >= 0
    AND compacted_through_sequence < sequence
    AND origin = 'runtime'
    AND source = 'compact'
    AND COALESCE(metadata ->> 'kind', '') = 'compact_boundary'
    AND (metadata -> 'compactedThroughSequence') IS NULL
    AND (metadata -> 'compactedUpToSequence') IS NULL
    AND COALESCE(metadata ->> 'trigger', '') IN ('manual', 'auto')
    AND CASE
      WHEN (metadata -> 'preservedTailUserTurns')::text IS NULL THEN FALSE
      WHEN (metadata -> 'preservedTailUserTurns')::text LIKE '"%' THEN FALSE
      WHEN (metadata -> 'preservedTailUserTurns')::text IN ('true', 'false', 'null') THEN FALSE
      WHEN (metadata -> 'preservedTailUserTurns')::text LIKE '{%' THEN FALSE
      WHEN (metadata -> 'preservedTailUserTurns')::text LIKE '[%' THEN FALSE
      ELSE
        (metadata ->> 'preservedTailUserTurns')::numeric BETWEEN 0 AND 9007199254740991
        AND (metadata -> 'preservedTailUserTurns')::text NOT LIKE '%.%'
        AND LOWER((metadata -> 'preservedTailUserTurns')::text) NOT LIKE '%e%'
    END
  `;
}
async function ensureSingleRunningRunPerThread(pool, tables3) {
  await pool.query(`
    UPDATE ${tables3.runs}
    SET status = 'failed',
        finished_at = COALESCE(finished_at, NOW()),
        error = COALESCE(error, 'Legacy running run had no durable daemon owner during run-claim migration.')
    WHERE status = 'running'
      AND (owner_source IS NULL OR owner_key IS NULL OR owner_holder_id IS NULL)
  `);
  const runningRuns = await pool.query(`
    SELECT id, thread_id
    FROM ${tables3.runs}
    WHERE status = 'running'
    ORDER BY thread_id, started_at DESC, id DESC
  `);
  const retainedThreads = /* @__PURE__ */ new Set();
  const staleRunIds = runningRuns.rows.flatMap((row) => {
    if (!isJsonRecord(row) || typeof row.id !== "string" || typeof row.thread_id !== "string") {
      return [];
    }
    if (!retainedThreads.has(row.thread_id)) {
      retainedThreads.add(row.thread_id);
      return [];
    }
    return [row.id];
  });
  if (staleRunIds.length > 0) {
    await pool.query(`
      UPDATE ${tables3.runs}
      SET status = 'failed',
          finished_at = COALESCE(finished_at, NOW()),
          error = COALESCE(error, 'Superseded duplicate running run repaired by the durable run-claim migration.')
      WHERE id = ANY($1::UUID[])
    `, [staleRunIds]);
  }
  const versionResult = await pool.query("SHOW server_version");
  const serverVersion = isJsonRecord(versionResult.rows[0]) ? versionResult.rows[0].server_version : void 0;
  if (typeof serverVersion === "string" && serverVersion.includes("pg-mem")) {
    return;
  }
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_runs_one_running_per_thread_idx`)}
    ON ${tables3.runs} (thread_id)
    WHERE status = 'running'
  `);
}
async function readExistingThreadColumns(pool, columns) {
  if (columns.length === 0) {
    return /* @__PURE__ */ new Set();
  }
  const result = await pool.query(`
    SELECT table_schema, column_name
    FROM information_schema.columns
    WHERE table_name = $1
      AND table_schema IN ($2, 'public')
  `, ["threads", RUNTIME_SCHEMA]);
  const requestedColumns = new Set(columns);
  const rows = result.rows.flatMap((row) => {
    if (!isJsonRecord(row) || typeof row.table_schema !== "string" || typeof row.column_name !== "string") {
      return [];
    }
    return [{
      tableSchema: row.table_schema,
      columnName: row.column_name
    }];
  });
  const runtimeRows = rows.filter((row) => row.tableSchema === RUNTIME_SCHEMA);
  const candidateRows = runtimeRows.length > 0 ? runtimeRows : rows.filter((row) => row.tableSchema === "public");
  return new Set(candidateRows.map((row) => row.columnName).filter((column) => requestedColumns.has(column)));
}
async function dropReadonlyThreadsViewForColumnCleanup(pool, existingCleanupColumns) {
  if (existingCleanupColumns.size === 0) {
    return;
  }
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(SESSION_SCHEMA)}`);
  try {
    await pool.query(`DROP VIEW IF EXISTS ${quoteQualifiedIdentifier(SESSION_SCHEMA, "threads")}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("pg-mem") && message.includes("Unexpected word token")) {
      return;
    }
    throw error;
  }
}
async function ensureThreadsTable(pool, tables3) {
  if (await postgresRelationExists(pool, RUNTIME_SCHEMA, "threads")) {
    return;
  }
  await pool.query(`
    CREATE TABLE ${tables3.threads} (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      replaces_thread_id TEXT,
      runtime_state JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
async function backfillWorkerMetadataFromLegacyThreadContext(pool, tables3, existingContextColumns) {
  if (!existingContextColumns.has(LEGACY_THREAD_CONTEXT_COLUMN)) {
    return;
  }
  const sessionTables = buildSessionTableNames();
  await pool.query(`
    UPDATE ${sessionTables.sessions}
    SET metadata = jsonb_set(COALESCE(${sessionTables.sessions}.metadata, '{}'::jsonb), '{worker}', thread.context->'worker'),
        updated_at = NOW()
    FROM ${tables3.threads} AS thread
    WHERE ${sessionTables.sessions}.kind = 'worker'
      AND ${sessionTables.sessions}.current_thread_id = thread.id
      AND thread.session_id = ${sessionTables.sessions}.id
      AND thread.context->'worker' IS NOT NULL
      AND (${sessionTables.sessions}.metadata IS NULL OR ${sessionTables.sessions}.metadata->'worker' IS NULL)
  `);
}
async function migrateSessionRuntimeConfigFromThreadRows(pool, tables3) {
  const sessionTables = buildSessionTableNames();
  const movedColumns = [
    "model",
    "thinking",
    "pending_wake_at",
    "prompt_cache_key",
    "inference_projection"
  ];
  const existingColumns = await readExistingThreadColumns(pool, movedColumns);
  if (existingColumns.has("prompt_cache_key")) {
    const customPromptCacheKeys = await pool.query(`
      SELECT id, prompt_cache_key
      FROM ${tables3.threads}
      WHERE prompt_cache_key IS NOT NULL
        AND prompt_cache_key <> ('thread:' || id)
      LIMIT 1
    `);
    if (customPromptCacheKeys.rows.length > 0) {
      const row = customPromptCacheKeys.rows[0];
      throw new Error(
        `Cannot drop runtime.threads.prompt_cache_key while custom key exists on thread ${String(row.id)}.`
      );
    }
  }
  const hasModel = existingColumns.has("model");
  const hasThinking = existingColumns.has("thinking");
  const hasPendingWake = existingColumns.has("pending_wake_at");
  const hasInferenceProjection = existingColumns.has("inference_projection");
  if (hasModel || hasThinking || hasPendingWake || hasInferenceProjection) {
    const modelExpression = hasModel ? "CASE WHEN t.model = '' THEN NULL ELSE t.model END" : "NULL::text";
    const thinkingExpression = hasThinking ? "CASE WHEN t.thinking IS NOT NULL AND NOT (s.kind = 'worker' AND t.thinking = 'xhigh') THEN t.thinking ELSE NULL END" : "NULL::text";
    const thinkingConfiguredExpression = hasThinking ? "CASE WHEN t.thinking IS NOT NULL AND NOT (s.kind = 'worker' AND t.thinking = 'xhigh') THEN TRUE ELSE FALSE END" : "FALSE";
    const inferenceProjectionExpression = hasInferenceProjection ? "t.inference_projection" : "NULL::jsonb";
    const pendingWakeExpression = hasPendingWake ? "t.pending_wake_at" : "NULL::timestamptz";
    const predicates = [
      ...hasModel ? ["t.model IS NOT NULL AND t.model <> ''"] : [],
      ...hasThinking ? ["t.thinking IS NOT NULL AND NOT (s.kind = 'worker' AND t.thinking = 'xhigh')"] : [],
      ...hasInferenceProjection ? ["t.inference_projection IS NOT NULL"] : [],
      ...hasPendingWake ? ["t.pending_wake_at IS NOT NULL"] : []
    ];
    await pool.query(`
      INSERT INTO ${sessionTables.sessionRuntimeConfig} AS config (
        session_id,
        model,
        thinking,
        thinking_configured,
        inference_projection,
        pending_wake_at
      )
      SELECT
        s.id,
        ${modelExpression},
        ${thinkingExpression},
        ${thinkingConfiguredExpression},
        ${inferenceProjectionExpression},
        ${pendingWakeExpression}
      FROM ${sessionTables.sessions} AS s
      INNER JOIN ${tables3.threads} AS t
        ON t.id = s.current_thread_id
       AND t.session_id = s.id
      WHERE ${predicates.length > 0 ? predicates.map((predicate) => `(${predicate})`).join(" OR ") : "FALSE"}
      ON CONFLICT (session_id) DO UPDATE
      SET model = COALESCE(config.model, EXCLUDED.model),
          thinking = CASE
            WHEN config.thinking_configured THEN config.thinking
            ELSE EXCLUDED.thinking
          END,
          thinking_configured = config.thinking_configured OR EXCLUDED.thinking_configured,
          inference_projection = COALESCE(config.inference_projection, EXCLUDED.inference_projection),
          pending_wake_at = COALESCE(config.pending_wake_at, EXCLUDED.pending_wake_at),
          updated_at = NOW()
      WHERE (config.model IS NULL AND EXCLUDED.model IS NOT NULL)
         OR (NOT config.thinking_configured AND EXCLUDED.thinking_configured)
         OR (config.inference_projection IS NULL AND EXCLUDED.inference_projection IS NOT NULL)
         OR (config.pending_wake_at IS NULL AND EXCLUDED.pending_wake_at IS NOT NULL)
    `);
  }
  for (const column of movedColumns) {
    await pool.query(`ALTER TABLE ${tables3.threads} DROP COLUMN IF EXISTS ${quoteIdentifier(column)}`);
  }
}
function buildThreadRuntimeSchemaSql(tables3, identityTableName) {
  return `
    ${CREATE_RUNTIME_SCHEMA_SQL}

    ALTER TABLE ${tables3.threads}
    ADD COLUMN IF NOT EXISTS runtime_state JSONB;

    ALTER TABLE ${tables3.threads}
    ADD COLUMN IF NOT EXISTS replaces_thread_id TEXT;

    ALTER TABLE ${tables3.threads}
    DROP COLUMN IF EXISTS max_input_tokens;

    ALTER TABLE ${tables3.threads}
    DROP COLUMN IF EXISTS provider;

    ALTER TABLE ${tables3.threads}
    DROP COLUMN IF EXISTS system_prompt;

    ALTER TABLE ${tables3.threads}
    DROP COLUMN IF EXISTS max_turns;

    ALTER TABLE ${tables3.threads}
    DROP COLUMN IF EXISTS temperature;

    ALTER TABLE ${tables3.threads}
    DROP COLUMN IF EXISTS context;

    CREATE TABLE IF NOT EXISTS ${tables3.messages} (
      id UUID PRIMARY KEY,
      input_id UUID,
      thread_id TEXT NOT NULL REFERENCES ${tables3.threads}(id) ON DELETE CASCADE,
      sequence BIGSERIAL NOT NULL,
      origin TEXT NOT NULL,
      source TEXT NOT NULL,
      channel_id TEXT,
      external_message_id TEXT,
      actor_id TEXT,
      identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      run_id UUID,
      run_thread_id TEXT,
      created_at TIMESTAMPTZ NOT NULL,
      metadata JSONB,
      message JSONB NOT NULL
    );

    ALTER TABLE ${tables3.messages}
    ADD COLUMN IF NOT EXISTS metadata JSONB;

    ALTER TABLE ${tables3.messages}
    ADD COLUMN IF NOT EXISTS input_id UUID;

    ALTER TABLE ${tables3.messages}
    ADD COLUMN IF NOT EXISTS run_thread_id TEXT;

    ALTER TABLE ${tables3.messages}
    ADD COLUMN IF NOT EXISTS compacted_through_sequence BIGINT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_messages_thread_sequence_idx`)}
    ON ${tables3.messages} (thread_id, sequence);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_messages_compact_checkpoint_idx`)}
    ON ${tables3.messages} (thread_id, sequence DESC)
    WHERE compacted_through_sequence IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_messages_input_id_idx`)}
    ON ${tables3.messages} (input_id)
    WHERE input_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_threads_session_updated_idx`)}
    ON ${tables3.threads} (session_id, updated_at DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_threads_session_id_id_idx`)}
    ON ${tables3.threads} (session_id, id);

    CREATE TABLE IF NOT EXISTS ${tables3.inputs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables3.threads}(id) ON DELETE CASCADE,
      input_order BIGSERIAL NOT NULL,
      delivery_mode TEXT NOT NULL DEFAULT 'wake',
      source TEXT NOT NULL,
      connector_key TEXT NOT NULL DEFAULT '',
      channel_id TEXT,
      external_message_id TEXT,
      actor_id TEXT,
      identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL,
      applied_at TIMESTAMPTZ,
      applied_run_id UUID,
      discarded_at TIMESTAMPTZ,
      metadata JSONB,
      message JSONB
    );

    ALTER TABLE ${tables3.inputs}
    ADD COLUMN IF NOT EXISTS metadata JSONB;

    ALTER TABLE ${tables3.inputs}
    ADD COLUMN IF NOT EXISTS connector_key TEXT;

    UPDATE ${tables3.inputs}
    SET connector_key = COALESCE(metadata -> 'route' ->> 'connectorKey', '')
    WHERE connector_key IS NULL;

    ALTER TABLE ${tables3.inputs}
    ALTER COLUMN connector_key SET DEFAULT '';

    ALTER TABLE ${tables3.inputs}
    ALTER COLUMN connector_key SET NOT NULL;

    ALTER TABLE ${tables3.inputs}
    ADD COLUMN IF NOT EXISTS applied_run_id UUID;

    ALTER TABLE ${tables3.inputs}
    ADD COLUMN IF NOT EXISTS discarded_at TIMESTAMPTZ;

    ALTER TABLE ${tables3.inputs}
    ALTER COLUMN message DROP NOT NULL;

    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(
    RUNTIME_SCHEMA,
    `${tables3.prefix}_inputs_thread_order_idx`
  )};

    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(
    RUNTIME_SCHEMA,
    `${tables3.prefix}_inputs_pending_idx`
  )};

    CREATE INDEX ${quoteIdentifier(`${tables3.prefix}_inputs_pending_idx`)}
    ON ${tables3.inputs} (thread_id, input_order)
    WHERE applied_at IS NULL AND discarded_at IS NULL;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_inputs_runnable_idx`)}
    ON ${tables3.inputs} (thread_id, input_order)
    WHERE applied_at IS NULL AND discarded_at IS NULL AND delivery_mode = 'wake';

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_inputs_thread_id_id_idx`)}
    ON ${tables3.inputs} (thread_id, id);

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_inputs_external_message_connector_key_idx`)}
    ON ${tables3.inputs} (
      thread_id,
      source,
      connector_key,
      COALESCE(channel_id, ''),
      external_message_id
    )
    WHERE external_message_id IS NOT NULL;

    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(
    RUNTIME_SCHEMA,
    `${tables3.prefix}_inputs_external_message_connector_idx`
  )};

    DROP INDEX IF EXISTS ${quoteQualifiedIdentifier(
    RUNTIME_SCHEMA,
    `${tables3.prefix}_inputs_external_message_idx`
  )};

    CREATE TABLE IF NOT EXISTS ${tables3.runs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables3.threads}(id) ON DELETE CASCADE,
      owner_source TEXT,
      owner_key TEXT,
      owner_holder_id TEXT,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      abort_requested_at TIMESTAMPTZ,
      abort_reason TEXT,
      error TEXT
    );

    ALTER TABLE ${tables3.runs}
    ADD COLUMN IF NOT EXISTS owner_source TEXT;

    ALTER TABLE ${tables3.runs}
    ADD COLUMN IF NOT EXISTS owner_key TEXT;

    ALTER TABLE ${tables3.runs}
    ADD COLUMN IF NOT EXISTS owner_holder_id TEXT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_runs_thread_started_idx`)}
    ON ${tables3.runs} (thread_id, started_at);

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_runs_thread_id_id_idx`)}
    ON ${tables3.runs} (thread_id, id);

    CREATE TABLE IF NOT EXISTS ${tables3.toolJobs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables3.threads}(id) ON DELETE CASCADE,
      run_id UUID REFERENCES ${tables3.runs}(id) ON DELETE SET NULL,
      run_thread_id TEXT,
      owner_source TEXT,
      owner_key TEXT,
      owner_holder_id TEXT,
      parent_tool_call_id TEXT,
      command_ordinal BIGINT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      duration_ms BIGINT,
      result JSONB,
      error TEXT,
      status_reason TEXT,
      progress JSONB
    );

    ALTER TABLE ${tables3.toolJobs}
    ADD COLUMN IF NOT EXISTS run_thread_id TEXT;

    ALTER TABLE ${tables3.toolJobs}
    ADD COLUMN IF NOT EXISTS owner_source TEXT;

    ALTER TABLE ${tables3.toolJobs}
    ADD COLUMN IF NOT EXISTS owner_key TEXT;

    ALTER TABLE ${tables3.toolJobs}
    ADD COLUMN IF NOT EXISTS owner_holder_id TEXT;

    ALTER TABLE ${tables3.toolJobs}
    ADD COLUMN IF NOT EXISTS parent_tool_call_id TEXT;

    ALTER TABLE ${tables3.toolJobs}
    ADD COLUMN IF NOT EXISTS command_ordinal BIGINT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_tool_jobs_thread_started_idx`)}
    ON ${tables3.toolJobs} (thread_id, started_at);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_tool_jobs_status_idx`)}
    ON ${tables3.toolJobs} (status, started_at);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_tool_jobs_running_owner_idx`)}
    ON ${tables3.toolJobs} (owner_source, owner_key, owner_holder_id, started_at)
    WHERE status = 'running';

    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_tool_jobs_parent_ordinal_idx`)}
    ON ${tables3.toolJobs} (thread_id, run_id, parent_tool_call_id, command_ordinal)
    WHERE parent_tool_call_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS ${tables3.bashJobs} (
      id UUID PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES ${tables3.threads}(id) ON DELETE CASCADE,
      run_id UUID REFERENCES ${tables3.runs}(id) ON DELETE SET NULL,
      run_thread_id TEXT,
      status TEXT NOT NULL,
      command TEXT NOT NULL,
      mode TEXT NOT NULL,
      initial_cwd TEXT NOT NULL,
      final_cwd TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      finished_at TIMESTAMPTZ,
      duration_ms BIGINT,
      exit_code INTEGER,
      signal TEXT,
      timed_out BOOLEAN NOT NULL DEFAULT FALSE,
      stdout TEXT NOT NULL DEFAULT '',
      stderr TEXT NOT NULL DEFAULT '',
      stdout_chars BIGINT NOT NULL DEFAULT 0,
      stderr_chars BIGINT NOT NULL DEFAULT 0,
      stdout_truncated BOOLEAN NOT NULL DEFAULT FALSE,
      stderr_truncated BOOLEAN NOT NULL DEFAULT FALSE,
      stdout_persisted BOOLEAN NOT NULL DEFAULT FALSE,
      stderr_persisted BOOLEAN NOT NULL DEFAULT FALSE,
      stdout_path TEXT,
      stderr_path TEXT,
      tracked_env_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
      status_reason TEXT
    );

    ALTER TABLE ${tables3.bashJobs}
    ADD COLUMN IF NOT EXISTS run_thread_id TEXT;

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_bash_jobs_thread_started_idx`)}
    ON ${tables3.bashJobs} (thread_id, started_at);

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_bash_jobs_status_idx`)}
    ON ${tables3.bashJobs} (status, started_at);

    CREATE TABLE IF NOT EXISTS ${tables3.shellStates} (
      session_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      execution_environment_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      env JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, thread_id, execution_environment_id),
      FOREIGN KEY (session_id, thread_id)
        REFERENCES ${tables3.threads}(session_id, id)
        ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_shell_states_thread_idx`)}
    ON ${tables3.shellStates} (session_id, thread_id);
  `;
}
function buildThreadRuntimeIntegrityChecks() {
  const tables3 = buildThreadRuntimeTableNames();
  const sessionTableName = buildSessionTableNames().sessions;
  return { scope: "Thread runtime schema", checks: [
    {
      label: "threads.session_id orphaned from agent_sessions.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.threads} AS thread
        LEFT JOIN ${sessionTableName} AS session
          ON session.id = thread.session_id
        WHERE session.id IS NULL
      `
    },
    {
      label: "threads.replaces_thread_id points outside its session",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.threads} AS thread
        LEFT JOIN ${tables3.threads} AS replaced
          ON replaced.id = thread.replaces_thread_id
         AND replaced.session_id = thread.session_id
        WHERE thread.replaces_thread_id IS NOT NULL
          AND replaced.id IS NULL
      `
    },
    {
      label: "agent_sessions.current_thread_id orphaned from threads.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${sessionTableName} AS session
        LEFT JOIN ${tables3.threads} AS thread
          ON thread.id = session.current_thread_id
        WHERE thread.id IS NULL
      `
    },
    {
      label: "agent_sessions.current_thread_id bound to a thread from another session",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${sessionTableName} AS session
        INNER JOIN ${tables3.threads} AS thread
          ON thread.id = session.current_thread_id
        WHERE thread.session_id <> session.id
      `
    },
    {
      label: "running thread runs missing durable daemon ownership",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.runs}
        WHERE status = 'running'
          AND (owner_source IS NULL OR owner_key IS NULL OR owner_holder_id IS NULL)
      `
    },
    {
      label: "messages.run_id orphaned from runs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.messages} AS message
        LEFT JOIN ${tables3.runs} AS run
          ON run.id = message.run_id
        WHERE message.run_id IS NOT NULL
          AND run.id IS NULL
      `
    },
    {
      label: "messages.run_id bound to a run from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.messages} AS message
        INNER JOIN ${tables3.runs} AS run
          ON run.id = message.run_id
        WHERE message.run_id IS NOT NULL
          AND run.thread_id <> message.thread_id
      `
    },
    {
      label: "messages contain malformed compaction checkpoints",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.messages}
        WHERE (
          compacted_through_sequence IS NULL
          AND COALESCE(metadata ->> 'kind', '') = 'compact_boundary'
        ) OR (
          compacted_through_sequence IS NOT NULL
          AND NOT (${buildValidCompactionCheckpointSql()})
        )
      `
    },
    {
      label: "inputs.applied_run_id orphaned from runs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.inputs} AS input
        LEFT JOIN ${tables3.runs} AS run
          ON run.id = input.applied_run_id
        WHERE input.applied_run_id IS NOT NULL
          AND run.id IS NULL
      `
    },
    {
      label: "inputs.applied_run_id bound to a run from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.inputs} AS input
        INNER JOIN ${tables3.runs} AS run
          ON run.id = input.applied_run_id
        WHERE run.thread_id <> input.thread_id
      `
    },
    {
      label: "messages.input_id orphaned from inputs.id",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.messages} AS message
        LEFT JOIN ${tables3.inputs} AS input
          ON input.id = message.input_id
        WHERE message.input_id IS NOT NULL
          AND input.id IS NULL
      `
    },
    {
      label: "messages.input_id bound to an input from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.messages} AS message
        INNER JOIN ${tables3.inputs} AS input
          ON input.id = message.input_id
        WHERE input.thread_id <> message.thread_id
      `
    },
    {
      label: "applied input missing canonical message link",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.inputs} AS input
        LEFT JOIN ${tables3.messages} AS message
          ON message.input_id = input.id
        WHERE input.applied_at IS NOT NULL
          AND message.id IS NULL
      `
    },
    {
      label: "non-applied input has a canonical message link",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.inputs} AS input
        INNER JOIN ${tables3.messages} AS message
          ON message.input_id = input.id
        WHERE input.applied_at IS NULL
      `
    },
    {
      label: "tool_jobs.run_id bound to a run from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.toolJobs} AS job
        INNER JOIN ${tables3.runs} AS run
          ON run.id = job.run_id
        WHERE job.run_id IS NOT NULL
          AND run.thread_id <> job.thread_id
      `
    },
    {
      label: "running tool_jobs missing durable daemon owner",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.toolJobs}
        WHERE status = 'running'
          AND (
            owner_source IS NULL
            OR owner_key IS NULL
            OR owner_holder_id IS NULL
          )
      `
    },
    {
      label: "tool_jobs have partial daemon owner",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.toolJobs}
        WHERE NOT (
          (owner_source IS NULL AND owner_key IS NULL AND owner_holder_id IS NULL)
          OR (owner_source IS NOT NULL AND owner_key IS NOT NULL AND owner_holder_id IS NOT NULL)
        )
      `
    },
    {
      label: "bash_jobs.run_id bound to a run from another thread",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.bashJobs} AS job
        INNER JOIN ${tables3.runs} AS run
          ON run.id = job.run_id
        WHERE job.run_id IS NOT NULL
          AND run.thread_id <> job.thread_id
      `
    }
  ] };
}
async function backfillLegacyAppliedInputMessageLinks(pool, tables3) {
  const appliedInput = await pool.query(`
    SELECT 1
    FROM ${tables3.inputs}
    WHERE applied_at IS NOT NULL
    LIMIT 1
  `);
  if (appliedInput.rows.length === 0) {
    return false;
  }
  const matchesLegacyInput = (messageAlias, inputAlias) => `
    ${messageAlias}.input_id IS NULL
    AND ${messageAlias}.origin = 'input'
    AND ${messageAlias}.thread_id = ${inputAlias}.thread_id
    AND ${messageAlias}.source = ${inputAlias}.source
    AND (${messageAlias}.channel_id = ${inputAlias}.channel_id
      OR (${messageAlias}.channel_id IS NULL AND ${inputAlias}.channel_id IS NULL))
    AND (${messageAlias}.external_message_id = ${inputAlias}.external_message_id
      OR (${messageAlias}.external_message_id IS NULL AND ${inputAlias}.external_message_id IS NULL))
    AND (${messageAlias}.actor_id = ${inputAlias}.actor_id
      OR (${messageAlias}.actor_id IS NULL AND ${inputAlias}.actor_id IS NULL))
    AND (${messageAlias}.identity_id = ${inputAlias}.identity_id
      OR (${messageAlias}.identity_id IS NULL AND ${inputAlias}.identity_id IS NULL))
    AND ${messageAlias}.created_at = ${inputAlias}.created_at
    AND (${messageAlias}.metadata = ${inputAlias}.metadata
      OR (${messageAlias}.metadata IS NULL AND ${inputAlias}.metadata IS NULL))
    AND ${messageAlias}.message = ${inputAlias}.message
  `;
  await assertIntegrityChecks(pool, "thread input lineage migration", [
    {
      label: "applied input has no unique canonical message",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM ${tables3.inputs} AS input
        WHERE input.applied_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ${tables3.messages} AS linked WHERE linked.input_id = input.id
          )
          AND (
            SELECT COUNT(*)
            FROM ${tables3.messages} AS message
            WHERE ${matchesLegacyInput("message", "input")}
          ) <> 1
      `
    },
    {
      label: "canonical message matches multiple applied inputs",
      sql: `
        SELECT COUNT(*)::INTEGER AS count
        FROM (
          SELECT message.id
          FROM ${tables3.messages} AS message
          INNER JOIN ${tables3.inputs} AS input
            ON ${matchesLegacyInput("message", "input")}
          WHERE input.applied_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM ${tables3.messages} AS linked WHERE linked.input_id = input.id
            )
          GROUP BY message.id
          HAVING COUNT(*) > 1
        ) AS ambiguous
      `
    }
  ]);
  await pool.query(`
    UPDATE ${tables3.messages} AS message
    SET input_id = input.id
    FROM ${tables3.inputs} AS input
    WHERE input.applied_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM ${tables3.messages} AS linked WHERE linked.input_id = input.id
      )
      AND ${matchesLegacyInput("message", "input")}
  `);
  await assertIntegrityChecks(pool, "thread input lineage migration", [{
    label: "applied input remains without canonical message link",
    sql: `
      SELECT COUNT(*)::INTEGER AS count
      FROM ${tables3.inputs} AS input
      WHERE input.applied_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM ${tables3.messages} AS message WHERE message.input_id = input.id
        )
    `
  }]);
  return true;
}
async function backfillToolJobOwners(pool, tables3) {
  await pool.query(`
    UPDATE ${tables3.toolJobs}
    SET owner_source = run.owner_source,
        owner_key = run.owner_key,
        owner_holder_id = run.owner_holder_id
    FROM ${tables3.runs} AS run
    WHERE ${tables3.toolJobs}.run_id = run.id
      AND ${tables3.toolJobs}.thread_id = run.thread_id
      AND run.owner_source IS NOT NULL
      AND run.owner_key IS NOT NULL
      AND run.owner_holder_id IS NOT NULL
      AND (
        ${tables3.toolJobs}.owner_source IS NULL
        OR ${tables3.toolJobs}.owner_source <> run.owner_source
        OR ${tables3.toolJobs}.owner_key IS NULL
        OR ${tables3.toolJobs}.owner_key <> run.owner_key
        OR ${tables3.toolJobs}.owner_holder_id IS NULL
        OR ${tables3.toolJobs}.owner_holder_id <> run.owner_holder_id
      )
  `);
  await pool.query(`
    UPDATE ${tables3.toolJobs}
    SET status = 'lost',
        finished_at = COALESCE(finished_at, NOW()),
        duration_ms = COALESCE(duration_ms, 0),
        status_reason = COALESCE(
          status_reason,
          'Background job had no durable daemon owner during schema upgrade.'
        )
    WHERE status = 'running'
      AND (
        owner_source IS NULL
        OR owner_key IS NULL
        OR owner_holder_id IS NULL
      )
  `);
  await pool.query(`
    UPDATE ${tables3.toolJobs}
    SET owner_source = NULL,
        owner_key = NULL,
        owner_holder_id = NULL
    WHERE status <> 'running'
      AND NOT (
        (owner_source IS NULL AND owner_key IS NULL AND owner_holder_id IS NULL)
        OR (owner_source IS NOT NULL AND owner_key IS NOT NULL AND owner_holder_id IS NOT NULL)
      )
  `);
}
async function ensurePostgresThreadRuntimeSchema(pool) {
  const tables3 = buildThreadRuntimeTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await ensureThreadsTable(pool, tables3);
  const existingLegacyScalarColumns = await readExistingThreadColumns(
    pool,
    LEGACY_THREAD_SCALAR_COLUMNS
  );
  const existingContextColumns = await readExistingThreadColumns(pool, [LEGACY_THREAD_CONTEXT_COLUMN]);
  await dropReadonlyThreadsViewForColumnCleanup(
    pool,
    /* @__PURE__ */ new Set([...existingLegacyScalarColumns, ...existingContextColumns])
  );
  await backfillWorkerMetadataFromLegacyThreadContext(pool, tables3, existingContextColumns);
  await pool.query(buildThreadRuntimeSchemaSql(tables3, identityTableName));
  await ensureSingleRunningRunPerThread(pool, tables3);
  await backfillToolJobOwners(pool, tables3);
  const hasAppliedInputs = await backfillLegacyAppliedInputMessageLinks(pool, tables3);
  if (hasAppliedInputs) {
    await pool.query(`
      UPDATE ${tables3.inputs}
      SET metadata = NULL,
          message = NULL
      WHERE applied_at IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM ${tables3.messages} AS message WHERE message.input_id = ${tables3.inputs}.id
        )
        AND (metadata IS NOT NULL OR message IS NOT NULL)
    `);
  }
  await migrateSessionRuntimeConfigFromThreadRows(pool, tables3);
  await ensureThreadRuntimeMigrationTable(pool);
  await migrateTypedCompactionCheckpoints(pool, tables3);
  await redactLegacySetEnvValueToolCallArguments(pool, tables3);
  const integrity = buildThreadRuntimeIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await pool.query(`
    UPDATE ${tables3.messages}
    SET run_thread_id = NULL
    WHERE run_id IS NULL
      AND run_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables3.messages}
    SET run_thread_id = run.thread_id
    FROM ${tables3.runs} AS run
    WHERE ${tables3.messages}.run_id IS NOT NULL
      AND run.id = ${tables3.messages}.run_id
      AND (
        ${tables3.messages}.run_thread_id IS NULL
        OR ${tables3.messages}.run_thread_id <> run.thread_id
      )
  `);
  await pool.query(`
    UPDATE ${tables3.toolJobs}
    SET run_thread_id = NULL
    WHERE run_id IS NULL
      AND run_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables3.toolJobs}
    SET run_thread_id = run.thread_id
    FROM ${tables3.runs} AS run
    WHERE ${tables3.toolJobs}.run_id IS NOT NULL
      AND run.id = ${tables3.toolJobs}.run_id
      AND (
        ${tables3.toolJobs}.run_thread_id IS NULL
        OR ${tables3.toolJobs}.run_thread_id <> run.thread_id
      )
  `);
  await pool.query(`
    UPDATE ${tables3.bashJobs}
    SET run_thread_id = NULL
    WHERE run_id IS NULL
      AND run_thread_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables3.bashJobs}
    SET run_thread_id = run.thread_id
    FROM ${tables3.runs} AS run
    WHERE ${tables3.bashJobs}.run_id IS NOT NULL
      AND run.id = ${tables3.bashJobs}.run_id
      AND (
        ${tables3.bashJobs}.run_thread_id IS NULL
        OR ${tables3.bashJobs}.run_thread_id <> run.thread_id
      )
  `);
  await alterIfSupported(pool, `
    ALTER TABLE ${tables3.threads}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_threads_session_fk`)}
    FOREIGN KEY (session_id)
    REFERENCES ${sessionTableName}(id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.threads}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_threads_replacement_fk`)}
    FOREIGN KEY (session_id, replaces_thread_id)
    REFERENCES ${tables3.threads}(session_id, id)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.runs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_runs_owner_shape_check`)}
    CHECK (
      (
        owner_source IS NULL
        AND owner_key IS NULL
        AND owner_holder_id IS NULL
      ) OR (
        owner_source IS NOT NULL
        AND owner_key IS NOT NULL
        AND owner_holder_id IS NOT NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.runs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_runs_running_owner_check`)}
    CHECK (
      status <> 'running'
      OR (
        owner_source IS NOT NULL
        AND owner_key IS NOT NULL
        AND owner_holder_id IS NOT NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_messages_compact_checkpoint_check`)}
    CHECK (
      (
        compacted_through_sequence IS NULL
        AND COALESCE(metadata ->> 'kind', '') <> 'compact_boundary'
      ) OR (
        ${buildValidCompactionCheckpointSql()}
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_messages_run_fk`)}
    FOREIGN KEY (run_id)
    REFERENCES ${tables3.runs}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_messages_run_scope_check`)}
    CHECK (
      (
        run_id IS NULL
        AND run_thread_id IS NULL
      ) OR (
        run_id IS NOT NULL
        AND run_thread_id = thread_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_messages_run_scope_fk`)}
    FOREIGN KEY (run_thread_id, run_id)
    REFERENCES ${tables3.runs}(thread_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.inputs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_inputs_lifecycle_check`)}
    CHECK (
      (
        applied_at IS NULL
        AND applied_run_id IS NULL
        AND discarded_at IS NULL
        AND message IS NOT NULL
      ) OR (
        applied_at IS NOT NULL
        AND discarded_at IS NULL
        AND message IS NULL
      ) OR (
        applied_at IS NULL
        AND applied_run_id IS NULL
        AND discarded_at IS NOT NULL
        AND message IS NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.inputs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_inputs_applied_run_scope_fk`)}
    FOREIGN KEY (thread_id, applied_run_id)
    REFERENCES ${tables3.runs}(thread_id, id)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_messages_input_scope_fk`)}
    FOREIGN KEY (thread_id, input_id)
    REFERENCES ${tables3.inputs}(thread_id, id)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.messages}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_messages_input_origin_check`)}
    CHECK (input_id IS NULL OR origin = 'input')
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_tool_jobs_run_scope_check`)}
    CHECK (
      (
        run_id IS NULL
        AND run_thread_id IS NULL
      ) OR (
        run_id IS NOT NULL
        AND run_thread_id = thread_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_tool_jobs_run_scope_fk`)}
    FOREIGN KEY (run_thread_id, run_id)
    REFERENCES ${tables3.runs}(thread_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_tool_jobs_command_lineage_check`)}
    CHECK (
      (
        parent_tool_call_id IS NULL
        AND command_ordinal IS NULL
      ) OR (
        parent_tool_call_id IS NOT NULL
        AND command_ordinal IS NOT NULL
        AND command_ordinal > 0
        AND kind = 'command'
        AND run_id IS NOT NULL
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_tool_jobs_owner_shape_check`)}
    CHECK (
      (owner_source IS NULL AND owner_key IS NULL AND owner_holder_id IS NULL)
      OR (owner_source IS NOT NULL AND owner_key IS NOT NULL AND owner_holder_id IS NOT NULL)
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.toolJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_tool_jobs_running_owner_check`)}
    CHECK (status <> 'running' OR owner_source IS NOT NULL)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.bashJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_bash_jobs_run_scope_check`)}
    CHECK (
      (
        run_id IS NULL
        AND run_thread_id IS NULL
      ) OR (
        run_id IS NOT NULL
        AND run_thread_id = thread_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.bashJobs}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_bash_jobs_run_scope_fk`)}
    FOREIGN KEY (run_thread_id, run_id)
    REFERENCES ${tables3.runs}(thread_id, id)
    ON DELETE SET NULL
  `);
  await alterIfSupported(pool, `
    ALTER TABLE ${sessionTableName}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_agent_sessions_current_thread_fk`)}
    FOREIGN KEY (id, current_thread_id)
    REFERENCES ${tables3.threads}(session_id, id)
    DEFERRABLE INITIALLY DEFERRED
  `);
}

// src/domain/watches/postgres-schema.ts
function buildWatchIntegrityChecks() {
  const tables3 = buildWatchTableNames();
  const threadTableName = buildThreadRuntimeTableNames().threads;
  return {
    scope: "Watch schema",
    checks: [
      {
        label: "watch_runs.watch_id orphaned from watches.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.watchRuns} AS run
          LEFT JOIN ${tables3.watches} AS watch ON watch.id = run.watch_id
          WHERE watch.id IS NULL
        `
      },
      {
        label: "watch_runs watch/session mismatch",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.watchRuns} AS run
          INNER JOIN ${tables3.watches} AS watch ON watch.id = run.watch_id
          WHERE watch.session_id <> run.session_id
        `
      },
      {
        label: "watch_runs.resolved_thread_id orphaned from threads.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.watchRuns} AS run
          LEFT JOIN ${threadTableName} AS thread ON thread.id = run.resolved_thread_id
          WHERE run.resolved_thread_id IS NOT NULL AND thread.id IS NULL
        `
      },
      {
        label: "watch_runs.resolved_thread_id bound to another session",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.watchRuns} AS run
          INNER JOIN ${threadTableName} AS thread ON thread.id = run.resolved_thread_id
          WHERE run.resolved_thread_id IS NOT NULL AND thread.session_id <> run.session_id
        `
      },
      {
        label: "watch_runs.emitted_event_id orphaned from watch_events.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.watchRuns} AS run
          LEFT JOIN ${tables3.watchEvents} AS event ON event.id = run.emitted_event_id
          WHERE run.emitted_event_id IS NOT NULL AND event.id IS NULL
        `
      },
      {
        label: "watch_runs.emitted_event_id bound to another watch",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.watchRuns} AS run
          INNER JOIN ${tables3.watchEvents} AS event ON event.id = run.emitted_event_id
          WHERE run.emitted_event_id IS NOT NULL AND event.watch_id <> run.watch_id
        `
      },
      {
        label: "watch_events watch/session mismatch",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.watchEvents} AS event
          INNER JOIN ${tables3.watches} AS watch ON watch.id = event.watch_id
          WHERE watch.session_id <> event.session_id
        `
      },
      {
        label: "watch_events.resolved_thread_id orphaned from threads.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.watchEvents} AS event
          LEFT JOIN ${threadTableName} AS thread ON thread.id = event.resolved_thread_id
          WHERE event.resolved_thread_id IS NOT NULL AND thread.id IS NULL
        `
      },
      {
        label: "watch_events.resolved_thread_id bound to another session",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${tables3.watchEvents} AS event
          INNER JOIN ${threadTableName} AS thread ON thread.id = event.resolved_thread_id
          WHERE event.resolved_thread_id IS NOT NULL AND thread.session_id <> event.session_id
        `
      }
    ]
  };
}
async function ensurePostgresWatchSchema(pool) {
  const tables3 = buildWatchTableNames();
  const identityTableName = buildIdentityTableNames().identities;
  const sessionTableName = buildSessionTableNames().sessions;
  const threadTableName = buildThreadRuntimeTableNames().threads;
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.watches} (
      id UUID PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      interval_minutes INTEGER NOT NULL,
      source_config JSONB NOT NULL,
      detector_config JSONB NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      next_poll_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      claim_expires_at TIMESTAMPTZ,
      cooldown_until TIMESTAMPTZ,
      last_error TEXT,
      state JSONB,
      disabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_watches_due_idx`)}
    ON ${tables3.watches} (enabled, disabled_at, next_poll_at, id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_watches_identity_agent_idx`)}
    ON ${tables3.watches} (session_id, created_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_watches_session_id_id_idx`)}
    ON ${tables3.watches} (session_id, id)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.watchRuns} (
      id UUID PRIMARY KEY,
      watch_id UUID NOT NULL REFERENCES ${tables3.watches}(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      resolved_thread_id TEXT,
      resolved_thread_session_id TEXT,
      emitted_event_watch_id UUID,
      emitted_event_id UUID,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_watch_runs_watch_created_idx`)}
    ON ${tables3.watchRuns} (watch_id, created_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.watchEvents} (
      id UUID PRIMARY KEY,
      watch_id UUID NOT NULL REFERENCES ${tables3.watches}(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES ${sessionTableName}(id) ON DELETE CASCADE,
      created_by_identity_id TEXT REFERENCES ${identityTableName}(id) ON DELETE SET NULL,
      resolved_thread_id TEXT,
      resolved_thread_session_id TEXT,
      event_kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      payload JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_watch_events_dedupe_idx`)}
    ON ${tables3.watchEvents} (watch_id, dedupe_key)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_watch_events_watch_created_idx`)}
    ON ${tables3.watchEvents} (watch_id, created_at DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_watch_events_watch_id_id_idx`)}
    ON ${tables3.watchEvents} (watch_id, id)
  `);
  await pool.query(`
    ALTER TABLE ${tables3.watchRuns}
    ADD COLUMN IF NOT EXISTS resolved_thread_session_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables3.watchRuns}
    ADD COLUMN IF NOT EXISTS emitted_event_watch_id UUID
  `);
  await pool.query(`
    ALTER TABLE ${tables3.watchEvents}
    ADD COLUMN IF NOT EXISTS resolved_thread_session_id TEXT
  `);
  await pool.query(`
    ALTER TABLE ${tables3.watchEvents}
    ALTER COLUMN resolved_thread_id DROP NOT NULL
  `);
  const integrity = buildWatchIntegrityChecks();
  await assertIntegrityChecks(pool, integrity.scope, integrity.checks);
  await pool.query(`
    UPDATE ${tables3.watchRuns}
    SET resolved_thread_session_id = NULL
    WHERE resolved_thread_id IS NULL
      AND resolved_thread_session_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables3.watchRuns}
    SET resolved_thread_session_id = thread.session_id
    FROM ${threadTableName} AS thread
    WHERE ${tables3.watchRuns}.resolved_thread_id IS NOT NULL
      AND thread.id = ${tables3.watchRuns}.resolved_thread_id
      AND (
        ${tables3.watchRuns}.resolved_thread_session_id IS NULL
        OR ${tables3.watchRuns}.resolved_thread_session_id <> thread.session_id
      )
  `);
  await pool.query(`
    UPDATE ${tables3.watchRuns}
    SET emitted_event_watch_id = NULL
    WHERE emitted_event_id IS NULL
      AND emitted_event_watch_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables3.watchRuns}
    SET emitted_event_watch_id = event.watch_id
    FROM ${tables3.watchEvents} AS event
    WHERE ${tables3.watchRuns}.emitted_event_id IS NOT NULL
      AND event.id = ${tables3.watchRuns}.emitted_event_id
      AND (
        ${tables3.watchRuns}.emitted_event_watch_id IS NULL
        OR ${tables3.watchRuns}.emitted_event_watch_id <> event.watch_id
      )
  `);
  await pool.query(`
    UPDATE ${tables3.watchEvents}
    SET resolved_thread_session_id = NULL
    WHERE resolved_thread_id IS NULL
      AND resolved_thread_session_id IS NOT NULL
  `);
  await pool.query(`
    UPDATE ${tables3.watchEvents}
    SET resolved_thread_session_id = thread.session_id
    FROM ${threadTableName} AS thread
    WHERE ${tables3.watchEvents}.resolved_thread_id IS NOT NULL
      AND thread.id = ${tables3.watchEvents}.resolved_thread_id
      AND (
        ${tables3.watchEvents}.resolved_thread_session_id IS NULL
        OR ${tables3.watchEvents}.resolved_thread_session_id <> thread.session_id
      )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_runs_watch_scope_fk`)}
    FOREIGN KEY (session_id, watch_id)
    REFERENCES ${tables3.watches}(session_id, id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_runs_resolved_thread_fk`)}
    FOREIGN KEY (resolved_thread_id)
    REFERENCES ${threadTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_runs_emitted_event_fk`)}
    FOREIGN KEY (emitted_event_id)
    REFERENCES ${tables3.watchEvents}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_runs_emitted_event_scope_check`)}
    CHECK (
      (
        emitted_event_id IS NULL
        AND emitted_event_watch_id IS NULL
      ) OR (
        emitted_event_id IS NOT NULL
        AND emitted_event_watch_id = watch_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_runs_emitted_event_scope_fk`)}
    FOREIGN KEY (emitted_event_watch_id, emitted_event_id)
    REFERENCES ${tables3.watchEvents}(watch_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_runs_resolved_thread_scope_check`)}
    CHECK (
      (
        resolved_thread_id IS NULL
        AND resolved_thread_session_id IS NULL
      ) OR (
        resolved_thread_id IS NOT NULL
        AND resolved_thread_session_id = session_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchRuns}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_runs_resolved_thread_scope_fk`)}
    FOREIGN KEY (resolved_thread_session_id, resolved_thread_id)
    REFERENCES ${threadTableName}(session_id, id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchEvents}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_events_watch_scope_fk`)}
    FOREIGN KEY (session_id, watch_id)
    REFERENCES ${tables3.watches}(session_id, id)
    ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchEvents}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_events_resolved_thread_fk`)}
    FOREIGN KEY (resolved_thread_id)
    REFERENCES ${threadTableName}(id)
    ON DELETE SET NULL
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchEvents}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_events_resolved_thread_scope_check`)}
    CHECK (
      (
        resolved_thread_id IS NULL
        AND resolved_thread_session_id IS NULL
      ) OR (
        resolved_thread_id IS NOT NULL
        AND resolved_thread_session_id = session_id
      )
    )
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.watchEvents}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_watch_events_resolved_thread_scope_fk`)}
    FOREIGN KEY (resolved_thread_session_id, resolved_thread_id)
    REFERENCES ${threadTableName}(session_id, id)
    ON DELETE SET NULL
  `);
}

// src/domain/wiki/postgres-shared.ts
function buildWikiBindingTableNames() {
  return buildRuntimeRelationNames({
    wikiBindings: "agent_wiki_bindings"
  });
}

// src/domain/wiki/postgres-schema.ts
async function ensurePostgresWikiBindingSchema(pool) {
  const tables3 = buildWikiBindingTableNames();
  const agentTables = buildAgentTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.wikiBindings} (
      agent_key TEXT PRIMARY KEY REFERENCES ${agentTables.agents}(agent_key) ON DELETE CASCADE,
      wiki_group_id INTEGER NOT NULL,
      namespace_path TEXT NOT NULL,
      api_token_ciphertext BYTEA NOT NULL,
      api_token_iv BYTEA NOT NULL,
      api_token_tag BYTEA NOT NULL,
      key_version SMALLINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CHECK (wiki_group_id > 0),
      CHECK (namespace_path <> '')
    )
  `);
}

// src/integrations/channels/whatsapp/auth-schema.ts
var WHATSAPP_CONNECTOR_ACCOUNT_HARD_CUT = "connector_accounts_v1_2026_08_16";
var WHATSAPP_MIGRATION_LOCK = "__whatsapp_schema_lock__";
function buildWhatsAppAuthTableNames() {
  return buildRuntimeRelationNames({
    authCreds: "whatsapp_account_auth_creds",
    authKeys: "whatsapp_account_auth_keys",
    runtimeStatus: "whatsapp_account_runtime_status",
    migrations: "whatsapp_migrations"
  });
}
async function applyWhatsAppConnectorAccountHardCut(queryable) {
  const tables3 = buildWhatsAppAuthTableNames();
  const identities = buildIdentityTableNames();
  const conversations = buildConversationSessionTableNames();
  const connectors = buildConnectorAccountTableNames();
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.migrations} (
      migration_key TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await queryable.query(`
    INSERT INTO ${tables3.migrations} (migration_key)
    VALUES ($1)
    ON CONFLICT (migration_key) DO NOTHING
  `, [WHATSAPP_MIGRATION_LOCK]);
  await queryable.query(`
    SELECT migration_key
    FROM ${tables3.migrations}
    WHERE migration_key = $1
    FOR UPDATE
  `, [WHATSAPP_MIGRATION_LOCK]);
  const applied = await queryable.query(`
    SELECT migration_key
    FROM ${tables3.migrations}
    WHERE migration_key = $1
  `, [WHATSAPP_CONNECTOR_ACCOUNT_HARD_CUT]);
  if (applied.rows.length > 0) {
    return;
  }
  const hasLegacyCreds = await postgresRelationExists(queryable, "runtime", "whatsapp_auth_creds");
  const hasLegacyKeys = await postgresRelationExists(queryable, "runtime", "whatsapp_auth_keys");
  await queryable.query(`DROP TABLE IF EXISTS "runtime"."whatsapp_auth_keys"`);
  await queryable.query(`DROP TABLE IF EXISTS "runtime"."whatsapp_auth_creds"`);
  if (hasLegacyCreds || hasLegacyKeys) {
    if (await postgresRelationExists(queryable, "runtime", "identity_bindings")) {
      await queryable.query(`DELETE FROM ${identities.identityBindings} WHERE source = 'whatsapp'`);
    }
    if (await postgresRelationExists(queryable, "runtime", "conversation_sessions")) {
      await queryable.query(`DELETE FROM ${conversations.conversationSessions} WHERE source = 'whatsapp'`);
    }
    await queryable.query(`DELETE FROM ${connectors.connectorAccounts} WHERE source = 'whatsapp'`);
  }
  await queryable.query(`
    INSERT INTO ${tables3.migrations} (migration_key)
    VALUES ($1)
  `, [WHATSAPP_CONNECTOR_ACCOUNT_HARD_CUT]);
}
async function ensurePostgresWhatsAppAuthSchema(pool) {
  const tables3 = buildWhatsAppAuthTableNames();
  const connectors = buildConnectorAccountTableNames();
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await ensurePostgresConnectorAccountSchema(pool);
  await applyWhatsAppConnectorAccountHardCut(pool);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables3.authCreds} (
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
    CREATE TABLE IF NOT EXISTS ${tables3.authKeys} (
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
    CREATE TABLE IF NOT EXISTS ${tables3.runtimeStatus} (
      account_id UUID PRIMARY KEY,
      socket_state TEXT NOT NULL,
      last_error TEXT,
      heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_whatsapp_account_auth_keys_updated_idx`)}
    ON ${tables3.authKeys} (updated_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables3.prefix}_whatsapp_account_runtime_heartbeat_idx`)}
    ON ${tables3.runtimeStatus} (heartbeat_at DESC)
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.authCreds}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_whatsapp_account_auth_creds_account_fk`)}
    FOREIGN KEY (account_id) REFERENCES ${connectors.connectorAccounts}(id) ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.authKeys}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_whatsapp_account_auth_keys_account_fk`)}
    FOREIGN KEY (account_id) REFERENCES ${connectors.connectorAccounts}(id) ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.runtimeStatus}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_whatsapp_account_runtime_account_fk`)}
    FOREIGN KEY (account_id) REFERENCES ${connectors.connectorAccounts}(id) ON DELETE CASCADE
  `);
  await addConstraint(pool, `
    ALTER TABLE ${tables3.runtimeStatus}
    ADD CONSTRAINT ${quoteIdentifier(`${tables3.prefix}_whatsapp_account_runtime_state_check`)}
    CHECK (socket_state IN ('idle', 'connecting', 'open', 'reconnecting', 'closed', 'stopped', 'error'))
  `);
}

// src/app/database/migrations/pre-ledger/daemon-state.ts
async function installPreLedgerDaemonStateSchema(queryable) {
  const daemonStateTable = buildRuntimeRelationNames({ daemonState: "daemon_state" }).daemonState;
  await queryable.query(CREATE_RUNTIME_SCHEMA_SQL);
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS ${daemonStateTable} (
      daemon_key TEXT PRIMARY KEY,
      heartbeat_at TIMESTAMPTZ NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// src/app/database/migrations/pre-ledger/discord-voice.ts
var tables = buildRuntimeRelationNames({ controls: "discord_voice_controls" });
async function installPreLedgerDiscordVoiceControlSchema(pool) {
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables.controls} (
      id UUID PRIMARY KEY, connector_key TEXT NOT NULL, operation TEXT NOT NULL,
      session_id TEXT NOT NULL, agent_key TEXT NOT NULL, channel_id TEXT,
      text TEXT, mode TEXT, voice_turn_id UUID, idempotency_key TEXT,
      status TEXT NOT NULL, result JSONB, error TEXT, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`ALTER TABLE ${tables.controls} ADD COLUMN IF NOT EXISTS text TEXT`);
  await pool.query(`ALTER TABLE ${tables.controls} ADD COLUMN IF NOT EXISTS mode TEXT`);
  await pool.query(`ALTER TABLE ${tables.controls} ADD COLUMN IF NOT EXISTS voice_turn_id UUID`);
  await pool.query(`ALTER TABLE ${tables.controls} ADD COLUMN IF NOT EXISTS idempotency_key TEXT`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_controls_pending_idx`)} ON ${tables.controls} (connector_key,status,created_at,id)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables.prefix}_discord_voice_controls_idempotency_idx`)} ON ${tables.controls} (idempotency_key)`);
}

// src/app/database/migrations/pre-ledger/live-voice.ts
var tables2 = buildRuntimeRelationNames({ sessions: "live_voice_sessions", turns: "live_voice_turns" });
async function installPreLedgerLiveVoiceSchema(pool) {
  await pool.query(CREATE_RUNTIME_SCHEMA_SQL);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables2.sessions} (
      id UUID PRIMARY KEY, source TEXT NOT NULL, connector_key TEXT NOT NULL,
      scope_key TEXT NOT NULL, room_key TEXT NOT NULL, session_id TEXT NOT NULL,
      agent_key TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
      state TEXT NOT NULL, transport_context JSONB, last_error TEXT,
      health_state TEXT, health_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
      health_observed_at TIMESTAMPTZ, diagnostics JSONB,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables2.prefix}_live_voice_sessions_active_scope_idx`)} ON ${tables2.sessions} (source,connector_key,scope_key) WHERE state IN ('connecting','connected')`);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables2.prefix}_live_voice_sessions_owner_idx`)} ON ${tables2.sessions} (session_id,source,connector_key,state)`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${tables2.turns} (
      id UUID PRIMARY KEY, live_voice_session_id UUID NOT NULL REFERENCES ${tables2.sessions}(id),
      provider_delegation_id TEXT NOT NULL, source_utterance_id UUID NOT NULL,
      session_id TEXT NOT NULL, agent_key TEXT NOT NULL, external_actor_id TEXT, identity_id TEXT,
      prompt TEXT NOT NULL, status TEXT NOT NULL, thread_id UUID, run_id UUID,
      result_text TEXT, final_control_id UUID, final_text TEXT, error TEXT, completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (live_voice_session_id, provider_delegation_id),
      UNIQUE (live_voice_session_id, source_utterance_id)
    )
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${tables2.prefix}_live_voice_turns_run_idx`)} ON ${tables2.turns} (run_id,status)`);
}
async function migratePreLedgerDiscordVoiceSchema(queryable) {
  const hasSessions = await postgresRelationExists(queryable, "runtime", "discord_voice_sessions");
  const hasTurns = await postgresRelationExists(queryable, "runtime", "discord_voice_turns");
  const hasRuntimeRequests = await postgresRelationExists(queryable, "runtime", "runtime_requests");
  if (hasRuntimeRequests) await queryable.query("DELETE FROM runtime.runtime_requests WHERE kind='discord_voice_delegation'");
  if (hasSessions) {
    await queryable.query(`
      INSERT INTO ${tables2.sessions} (id,source,connector_key,scope_key,room_key,session_id,agent_key,provider,model,state,transport_context,last_error,started_at,updated_at)
      SELECT voice_session_id,'discord',connector_key,guild_id,channel_id,session_id,agent_key,'openai-live',model,'disconnected',
        '{}'::jsonb,COALESCE(last_error,'legacy_schema_migrated'),started_at,updated_at
      FROM runtime.discord_voice_sessions ON CONFLICT (id) DO NOTHING
    `);
  }
  if (hasTurns) {
    await queryable.query("ALTER TABLE runtime.discord_voice_turns ADD COLUMN IF NOT EXISTS source_utterance_id UUID");
    await queryable.query("ALTER TABLE runtime.discord_voice_turns ADD COLUMN IF NOT EXISTS final_control_id UUID");
    await queryable.query("ALTER TABLE runtime.discord_voice_turns ADD COLUMN IF NOT EXISTS final_text TEXT");
    await queryable.query(`
      INSERT INTO ${tables2.sessions} (id,source,connector_key,scope_key,room_key,session_id,agent_key,provider,model,state,transport_context,last_error,started_at,updated_at)
      SELECT DISTINCT ON (legacy.voice_session_id) legacy.voice_session_id,'discord',legacy.connector_key,legacy.guild_id,legacy.channel_id,
        legacy.session_id,legacy.agent_key,'openai-live','gpt-live-1-codex','disconnected',
        '{}'::jsonb,'legacy_schema_migrated',legacy.created_at,legacy.updated_at
      FROM runtime.discord_voice_turns AS legacy
      ORDER BY legacy.voice_session_id,legacy.created_at
      ON CONFLICT (id) DO NOTHING
    `);
    await queryable.query(`
      INSERT INTO ${tables2.turns} (id,live_voice_session_id,provider_delegation_id,source_utterance_id,session_id,agent_key,external_actor_id,identity_id,prompt,status,thread_id,run_id,result_text,final_control_id,final_text,error,completed_at,created_at,updated_at)
      SELECT id,voice_session_id,delegation_id || CASE WHEN source_utterance_id IS NULL THEN ':' || id::text ELSE '' END,COALESCE(source_utterance_id,id),session_id,agent_key,external_actor_id,identity_id,prompt,
        CASE WHEN status IN ('completed','failed') THEN status ELSE 'failed' END,thread_id,run_id,result_text,final_control_id,final_text,
        CASE WHEN status IN ('completed','failed') THEN error ELSE COALESCE(error,'Live voice turn interrupted by schema migration.') END,
        CASE WHEN status IN ('completed','failed') THEN completed_at ELSE NOW() END,created_at,updated_at
      FROM runtime.discord_voice_turns ON CONFLICT DO NOTHING
    `);
    await queryable.query("DROP TABLE runtime.discord_voice_turns");
  }
  if (hasSessions) await queryable.query("DROP TABLE runtime.discord_voice_sessions");
}

// .temp/0001-pre-ledger-baseline-bundle-entry.ts
async function applyPreLedgerBaseline(queryable) {
  await ensurePostgresIdentitySchema(queryable);
  await ensurePostgresAgentSchema(queryable);
  await ensurePostgresSessionSchema(queryable);
  await ensurePostgresThreadRuntimeSchema(queryable);
  await ensurePostgresExecutionEnvironmentSchema(queryable);
  await ensurePostgresSubagentSchema(queryable);
  await ensurePostgresConnectorAccountSchema(queryable);
  await ensurePostgresWhatsAppAuthSchema(queryable);
  await ensurePostgresCredentialSchema(queryable);
  await ensurePostgresMcpSchema(queryable);
  await ensurePostgresWikiBindingSchema(queryable);
  await ensurePostgresTelegramStickerSchema(queryable);
  await ensurePostgresAgentAppAuthSchema(queryable);
  await ensurePostgresGatewaySchema(queryable);
  await ensurePostgresControlSchema(queryable);
  await ensurePostgresEmailSchema(queryable);
  await ensurePostgresConversationSessionSchema(queryable);
  await ensurePostgresSessionRouteSchema(queryable);
  await ensurePostgresA2ASessionBindingSchema(queryable);
  await ensurePostgresOutboundDeliverySchema(queryable);
  await ensurePostgresScheduledTaskSchema(queryable);
  await ensurePostgresWatchSchema(queryable);
  await ensurePostgresChannelActionSchema(queryable);
  await ensurePostgresChannelCursorSchema(queryable);
  await ensurePostgresConnectorLeaseSchema(queryable);
  await ensurePostgresRuntimeRequestSchema(queryable);
  await installPreLedgerDiscordVoiceControlSchema(queryable);
  await installPreLedgerLiveVoiceSchema(queryable);
  await migratePreLedgerDiscordVoiceSchema(queryable);
  await ensurePostgresModelCallTraceSchema(queryable);
  await installPreLedgerDaemonStateSchema(queryable);
  await ensureReadonlySessionQuerySchema({ queryable });
  await queryable.query(`
    CREATE TABLE IF NOT EXISTS "runtime"."schema_configuration" (
      configuration_key TEXT PRIMARY KEY,
      configuration_value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await queryable.query(`
    DROP TABLE IF EXISTS "runtime"."thread_runtime_migrations";
    DROP TABLE IF EXISTS "runtime"."whatsapp_migrations";
  `);
}
export {
  applyPreLedgerBaseline
};
