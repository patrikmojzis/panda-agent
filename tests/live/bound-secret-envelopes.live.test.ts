import {createCipheriv, createHash, randomBytes, randomUUID} from "node:crypto";

import {afterEach, beforeEach, describe, expect, it} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {SecretCrypto, type SecretContext} from "../../src/domain/secrets/crypto.js";
import {createPostgresMigrator} from "../../src/lib/postgres-migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;
const masterKey = "bound-secret-migration-master-key";
const boundMigrationIndex = PANDA_SCHEMA_MIGRATIONS.findIndex(({id}) => id === "0009_bound_secret_envelopes");

function sealV1(value: string) {
  const key = createHash("sha256").update(masterKey, "utf8").digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: Buffer.from(ciphertext.toString("base64"), "utf8"),
    iv: Buffer.from(iv.toString("base64"), "utf8"),
    tag: Buffer.from(cipher.getAuthTag().toString("base64"), "utf8"),
  };
}

describe("bound secret envelope migration", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let originalMasterKey: string | undefined;

  beforeEach(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/bound-secret-migration-live-test",
      max: 2,
    });
    originalMasterKey = process.env.CREDENTIALS_MASTER_KEY;
  });

  afterEach(async () => {
    if (originalMasterKey === undefined) delete process.env.CREDENTIALS_MASTER_KEY;
    else process.env.CREDENTIALS_MASTER_KEY = originalMasterKey;
    await pool?.end();
  });

  function migrator(count: number) {
    return createPostgresMigrator({
      pool,
      migrations: PANDA_SCHEMA_MIGRATIONS.slice(0, count),
      schemaName: "runtime",
      tableName: "schema_migrations",
      lockName: "panda:bound-secret-migration-live-test",
    });
  }

  async function installV1Schema(): Promise<void> {
    await migrator(boundMigrationIndex).migrate();
    await pool.query(`
      INSERT INTO runtime.agents (agent_key, display_name)
      VALUES ('panda', 'Panda');

      INSERT INTO runtime.agent_sessions (id, agent_key, kind, current_thread_id)
      VALUES ('migration-session', 'panda', 'main', 'migration-thread');

      INSERT INTO runtime.threads (id, session_id)
      VALUES ('migration-thread', 'migration-session');
    `);
  }

  async function insertEnvelope(sql: string, values: readonly unknown[]): Promise<void> {
    const encrypted = sealV1(String(values.at(-1)));
    await pool.query(sql, [...values.slice(0, -1), encrypted.ciphertext, encrypted.iv, encrypted.tag]);
  }

  liveIt("rewraps every active v1 secret with its persisted identity and removes stale attempts", async () => {
    await installV1Schema();
    const accountId = "10000000-0000-0000-0000-000000000001";
    await pool.query(`
      INSERT INTO runtime.connector_accounts (
        id, source, account_key, connector_key, owner_kind, owner_agent_key, status, config
      ) VALUES ($1, 'whatsapp', 'panda-main', 'whatsapp:panda-main', 'agent', 'panda', 'enabled', '{}'::jsonb)
    `, [accountId]);

    await insertEnvelope(`
      INSERT INTO runtime.credentials (
        id, env_key, agent_key, value_ciphertext, value_iv, value_tag, key_version
      ) VALUES ($1, 'OPENAI_API_KEY', 'panda', $2, $3, $4, 1)
    `, [randomUUID(), "credential-secret"]);
    const batchEnvelope = sealV1("batch-secret");
    await pool.query(`
      INSERT INTO runtime.credentials (
        id, env_key, agent_key, value_ciphertext, value_iv, value_tag, key_version
      )
      SELECT
        ('20000000-0000-0000-0000-' || LPAD(value::text, 12, '0'))::uuid,
        'BATCH_' || value::text,
        'panda',
        $1,
        $2,
        $3,
        1
      FROM GENERATE_SERIES(1, 201) AS batch(value)
    `, [batchEnvelope.ciphertext, batchEnvelope.iv, batchEnvelope.tag]);
    await insertEnvelope(`
      INSERT INTO runtime.connector_account_secrets (
        account_id, secret_key, value_ciphertext, value_iv, value_tag, key_version
      ) VALUES ($1, 'bot_token', $2, $3, $4, 1)
    `, [accountId, "connector-secret"]);
    await insertEnvelope(`
      INSERT INTO runtime.whatsapp_account_auth_creds (
        account_id, value_ciphertext, value_iv, value_tag, key_version
      ) VALUES ($1, $2, $3, $4, 1)
    `, [accountId, "whatsapp-creds"]);
    await insertEnvelope(`
      INSERT INTO runtime.whatsapp_account_auth_keys (
        account_id, category, key_id, value_ciphertext, value_iv, value_tag, key_version
      ) VALUES ($1, 'session', 'key-1', $2, $3, $4, 1)
    `, [accountId, "whatsapp-key"]);
    await insertEnvelope(`
      INSERT INTO runtime.agent_wiki_bindings (
        agent_key, wiki_group_id, namespace_path,
        api_token_ciphertext, api_token_iv, api_token_tag, key_version
      ) VALUES ('panda', 7, 'agents/panda', $1, $2, $3, 1)
    `, ["wiki-token"]);
    await insertEnvelope(`
      INSERT INTO runtime.agent_mcp_oauth_connections (
        agent_key, server_name, state_ciphertext, state_iv, state_tag, key_version
      ) VALUES ('panda', 'github', $1, $2, $3, 1)
    `, ["oauth-state"]);
    await insertEnvelope(`
      INSERT INTO runtime.agent_mcp_oauth_attempts (
        state_hash, agent_key, server_name, verifier_ciphertext, verifier_iv, verifier_tag,
        key_version, initiator_kind, initiated_session_id, expires_at
      ) VALUES ('active-state-hash', 'panda', 'github', $1, $2, $3, 1, 'agent', 'migration-session', NOW() + INTERVAL '5 minutes')
    `, ["oauth-verifier"]);
    await insertEnvelope(`
      INSERT INTO runtime.agent_mcp_oauth_connections (
        agent_key, server_name, state_ciphertext, state_iv, state_tag, key_version
      ) VALUES ('panda', 'stale', $1, $2, $3, 1)
    `, ["stale-oauth-state"]);
    await insertEnvelope(`
      INSERT INTO runtime.agent_mcp_oauth_attempts (
        state_hash, agent_key, server_name, verifier_ciphertext, verifier_iv, verifier_tag,
        key_version, initiator_kind, initiated_session_id, expires_at
      ) VALUES ('stale-state-hash', 'panda', 'stale', $1, $2, $3, 1, 'agent', 'migration-session', NOW() - INTERVAL '1 minute')
    `, ["stale-oauth-verifier"]);

    process.env.CREDENTIALS_MASTER_KEY = masterKey;
    await migrator(boundMigrationIndex + 1).migrate();

    const crypto = new SecretCrypto(masterKey);
    const cases: Array<{
      table: string;
      where: string;
      columns: readonly [string, string, string];
      context: SecretContext;
      plaintext: string;
    }> = [
      {table: "credentials", where: "env_key = 'OPENAI_API_KEY'", columns: ["value_ciphertext", "value_iv", "value_tag"], context: {purpose: "agent-credential", identity: ["panda", "OPENAI_API_KEY"]}, plaintext: "credential-secret"},
      {table: "connector_account_secrets", where: "secret_key = 'bot_token'", columns: ["value_ciphertext", "value_iv", "value_tag"], context: {purpose: "connector-account-secret", identity: [accountId, "bot_token"]}, plaintext: "connector-secret"},
      {table: "whatsapp_account_auth_creds", where: "account_id = '10000000-0000-0000-0000-000000000001'", columns: ["value_ciphertext", "value_iv", "value_tag"], context: {purpose: "whatsapp-auth-creds", identity: [accountId]}, plaintext: "whatsapp-creds"},
      {table: "whatsapp_account_auth_keys", where: "key_id = 'key-1'", columns: ["value_ciphertext", "value_iv", "value_tag"], context: {purpose: "whatsapp-auth-key", identity: [accountId, "session", "key-1"]}, plaintext: "whatsapp-key"},
      {table: "agent_wiki_bindings", where: "agent_key = 'panda'", columns: ["api_token_ciphertext", "api_token_iv", "api_token_tag"], context: {purpose: "wiki-api-token", identity: ["panda"]}, plaintext: "wiki-token"},
      {table: "agent_mcp_oauth_connections", where: "server_name = 'github'", columns: ["state_ciphertext", "state_iv", "state_tag"], context: {purpose: "mcp-oauth-connection", identity: ["panda", "github"]}, plaintext: "oauth-state"},
      {table: "agent_mcp_oauth_attempts", where: "state_hash = 'active-state-hash'", columns: ["verifier_ciphertext", "verifier_iv", "verifier_tag"], context: {purpose: "mcp-oauth-attempt", identity: ["active-state-hash", "panda", "github"]}, plaintext: "oauth-verifier"},
    ];
    for (const testCase of cases) {
      const [ciphertext, iv, tag] = testCase.columns;
      const result = await pool.query(`
        SELECT ${ciphertext} AS ciphertext, ${iv} AS iv, ${tag} AS tag, envelope_version
        FROM runtime.${testCase.table}
        WHERE ${testCase.where}
      `);
      const row = result.rows[0]!;
      expect(crypto.open({
        ciphertext: row.ciphertext,
        iv: row.iv,
        tag: row.tag,
        envelopeVersion: row.envelope_version,
      }, testCase.context)).toBe(testCase.plaintext);
    }
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM runtime.agent_mcp_oauth_attempts
      WHERE state_hash = 'stale-state-hash'
    `)).resolves.toMatchObject({rows: [{count: 0}]});
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM runtime.credentials
      WHERE envelope_version = 2
    `)).resolves.toMatchObject({rows: [{count: 202}]});
  });

  liveIt("rolls back every rewrap and the ledger entry when the master key is wrong", async () => {
    await installV1Schema();
    await insertEnvelope(`
      INSERT INTO runtime.credentials (
        id, env_key, agent_key, value_ciphertext, value_iv, value_tag, key_version
      ) VALUES ($1, 'OPENAI_API_KEY', 'panda', $2, $3, $4, 1)
    `, [randomUUID(), "credential-secret"]);

    process.env.CREDENTIALS_MASTER_KEY = "wrong-key";
    await expect(migrator(boundMigrationIndex + 1).migrate()).rejects.toThrow();

    await expect(pool.query(`
      SELECT key_version FROM runtime.credentials WHERE env_key = 'OPENAI_API_KEY'
    `)).resolves.toMatchObject({rows: [{key_version: 1}]});
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM runtime.schema_migrations
      WHERE migration_id = '0009_bound_secret_envelopes'
    `)).resolves.toMatchObject({rows: [{count: 0}]});

    process.env.CREDENTIALS_MASTER_KEY = masterKey;
    await expect(migrator(boundMigrationIndex + 1).migrate()).resolves.toMatchObject({current: true});
  });

  liveIt("rolls back earlier table rewraps when a later envelope is corrupt", async () => {
    await installV1Schema();
    const accountId = "10000000-0000-0000-0000-000000000001";
    await pool.query(`
      INSERT INTO runtime.connector_accounts (
        id, source, account_key, connector_key, owner_kind, owner_agent_key, status, config
      ) VALUES ($1, 'discord', 'panda-main', 'discord:panda-main', 'agent', 'panda', 'enabled', '{}'::jsonb)
    `, [accountId]);
    await insertEnvelope(`
      INSERT INTO runtime.credentials (
        id, env_key, agent_key, value_ciphertext, value_iv, value_tag, key_version
      ) VALUES ($1, 'OPENAI_API_KEY', 'panda', $2, $3, $4, 1)
    `, [randomUUID(), "credential-secret"]);
    const before = (await pool.query(`
      SELECT value_ciphertext FROM runtime.credentials WHERE env_key = 'OPENAI_API_KEY'
    `)).rows[0]!.value_ciphertext;
    await pool.query(`
      INSERT INTO runtime.connector_account_secrets (
        account_id, secret_key, value_ciphertext, value_iv, value_tag, key_version
      ) VALUES ($1, 'bot_token', '\\x00', '\\x00', '\\x00', 1)
    `, [accountId]);

    process.env.CREDENTIALS_MASTER_KEY = masterKey;
    await expect(migrator(boundMigrationIndex + 1).migrate()).rejects.toThrow();

    const after = (await pool.query(`
      SELECT value_ciphertext, key_version FROM runtime.credentials WHERE env_key = 'OPENAI_API_KEY'
    `)).rows[0]!;
    expect(after.key_version).toBe(1);
    expect(after.value_ciphertext).toEqual(before);
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count FROM runtime.schema_migrations
      WHERE migration_id = '0009_bound_secret_envelopes'
    `)).resolves.toMatchObject({rows: [{count: 0}]});
  });

  liveIt("migrates an empty database without requiring a master key", async () => {
    await installV1Schema();
    delete process.env.CREDENTIALS_MASTER_KEY;
    await expect(migrator(boundMigrationIndex + 1).migrate()).resolves.toMatchObject({current: true});
  });
});
