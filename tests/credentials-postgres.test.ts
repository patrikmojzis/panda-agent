import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {
  CredentialCrypto,
  CredentialResolver,
  CredentialService,
  PostgresCredentialStore,
} from "../src/domain/credentials/index.js";

describe("PostgresCredentialStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createHarness(options: {ensureCredentialSchema?: boolean} = {}) {
    const db = newDb();
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);

    const agentStore = new PostgresAgentStore({pool});
    const credentialStore = new PostgresCredentialStore({pool});
    await agentStore.ensureAgentTableSchema();
    if (options.ensureCredentialSchema !== false) {
      await credentialStore.ensureSchema();
    }

    const crypto = new CredentialCrypto("test-master-key");
    const credentialService = new CredentialService({
      store: credentialStore,
      crypto,
    });
    const credentialResolver = new CredentialResolver({
      store: credentialStore,
      crypto,
    });

    return {
      pool,
      agentStore,
      credentialResolver,
      credentialService,
      credentialStore,
    };
  }

  it("stores one row per agent env key and overwrites that exact row", async () => {
    const {
      agentStore,
      credentialResolver,
      credentialService,
      credentialStore,
      pool,
    } = await createHarness();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: {},
    });
    await credentialService.setCredential({
      envKey: "NOTION_API_KEY",
      value: "agent-token",
      agentKey: "panda",
    });
    await credentialService.setCredential({
      envKey: "NOTION_API_KEY",
      value: "agent-token-updated",
      agentKey: "panda",
    });
    await credentialService.setCredential({
      envKey: "NOTION_API_KEY",
      value: "ops-token",
      agentKey: "ops",
    });

    await expect(credentialResolver.resolveCredential("NOTION_API_KEY", {
      agentKey: "panda",
    })).resolves.toMatchObject({
      agentKey: "panda",
      value: "agent-token-updated",
    });
    await expect(credentialResolver.resolveCredential("NOTION_API_KEY", {
      agentKey: "ops",
    })).resolves.toMatchObject({
      agentKey: "ops",
      value: "ops-token",
    });
    await expect(credentialResolver.resolveEnvironment({
      agentKey: "panda",
    })).resolves.toEqual({
      NOTION_API_KEY: "agent-token-updated",
    });

    expect(await credentialStore.deleteCredential("NOTION_API_KEY", {
      agentKey: "panda",
    })).toBe(true);
    await expect(credentialResolver.resolveCredential("NOTION_API_KEY", {
      agentKey: "panda",
    })).resolves.toBeNull();

    const count = await pool.query("SELECT COUNT(*)::int AS count FROM runtime.credentials");
    expect(count.rows[0]?.count).toBe(1);
  });

  it("rejects blocked env keys before storage", async () => {
    const {credentialService} = await createHarness();

    await expect(credentialService.setCredential({
      envKey: "PATH",
      value: "nope",
      agentKey: "panda",
    })).rejects.toThrow("not allowed");

    await expect(credentialService.setCredential({
      envKey: "DATABASE_URL",
      value: "nope",
      agentKey: "panda",
    })).rejects.toThrow("reserved");
  });

  it("encrypts values at rest and returns masked previews through the service", async () => {
    const {agentStore, credentialService, credentialStore} = await createHarness();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });

    await credentialService.setCredential({
      envKey: "OPENAI_API_KEY",
      value: "sk-live-339398484",
      agentKey: "panda",
    });

    const raw = await credentialStore.getCredential("OPENAI_API_KEY", {
      agentKey: "panda",
    });
    expect(raw).not.toBeNull();
    expect(raw?.valueCiphertext.equals(Buffer.from("sk-live-339398484", "utf8"))).toBe(false);

    await expect(credentialService.listCredentials({
      agentKey: "panda",
    })).resolves.toEqual([
      expect.objectContaining({
        envKey: "OPENAI_API_KEY",
        valuePreview: "sk-l...8484",
      }),
    ]);
  });

  it("migrates old credential rows by keeping agent rows only", async () => {
    const {
      agentStore,
      credentialResolver,
      credentialStore,
      pool,
    } = await createHarness({ensureCredentialSchema: false});
    const crypto = new CredentialCrypto("test-master-key");
    const encryptAgent = crypto.encrypt("agent-token");
    const encryptRelationship = crypto.encrypt("relationship-token");

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });
    await pool.query(`
      CREATE TABLE runtime.credentials (
        id UUID PRIMARY KEY,
        env_key TEXT NOT NULL,
        scope TEXT NOT NULL,
        agent_key TEXT REFERENCES runtime.agents(agent_key) ON DELETE CASCADE,
        identity_id TEXT,
        value_ciphertext BYTEA NOT NULL,
        value_iv BYTEA NOT NULL,
        value_tag BYTEA NOT NULL,
        key_version SMALLINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`
      INSERT INTO runtime.credentials (
        id,
        env_key,
        scope,
        agent_key,
        identity_id,
        value_ciphertext,
        value_iv,
        value_tag,
        key_version
      ) VALUES
        ($1, 'NOTION_API_KEY', 'relationship', 'panda', 'alice-id', $2, $3, $4, $5),
        ($6, 'NOTION_API_KEY', 'agent', 'panda', NULL, $7, $8, $9, $10)
    `, [
      "00000000-0000-0000-0000-000000000001",
      encryptRelationship.ciphertext,
      encryptRelationship.iv,
      encryptRelationship.tag,
      encryptRelationship.keyVersion,
      "00000000-0000-0000-0000-000000000002",
      encryptAgent.ciphertext,
      encryptAgent.iv,
      encryptAgent.tag,
      encryptAgent.keyVersion,
    ]);

    await credentialStore.ensureSchema();

    const columns = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'runtime'
        AND table_name = 'credentials'
      ORDER BY column_name
    `);
    expect(columns.rows.map((row) => row.column_name)).not.toContain("scope");
    expect(columns.rows.map((row) => row.column_name)).not.toContain("identity_id");
    await expect(credentialResolver.resolveCredential("NOTION_API_KEY", {
      agentKey: "panda",
    })).resolves.toMatchObject({
      value: "agent-token",
    });

    const count = await pool.query("SELECT COUNT(*)::int AS count FROM runtime.credentials");
    expect(count.rows[0]?.count).toBe(1);
  });
});
