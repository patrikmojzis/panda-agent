import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {ensurePostgresAgentTableSchema} from "../src/domain/agents/postgres-schema.js";
import {SecretCrypto} from "../src/domain/secrets/crypto.js";
import {PostgresCredentialStore} from "../src/domain/credentials/postgres.js";
import {ensurePostgresCredentialSchema} from "../src/domain/credentials/postgres-schema.js";
import {CredentialResolver, CredentialService} from "../src/domain/credentials/resolver.js";

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
    await ensurePostgresAgentTableSchema(pool);
    if (options.ensureCredentialSchema !== false) {
      await ensurePostgresCredentialSchema(pool);
    }

    const crypto = new SecretCrypto("test-master-key");
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
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
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

  it("rejects ciphertext tuples swapped between credential identities", async () => {
    const {agentStore, credentialResolver, credentialService, pool} = await createHarness();
    await agentStore.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await credentialService.setCredential({agentKey: "panda", envKey: "OPENAI_API_KEY", value: "openai-secret"});
    await credentialService.setCredential({agentKey: "panda", envKey: "GITHUB_TOKEN", value: "github-secret"});

    const source = await pool.query(`
      SELECT value_ciphertext, value_iv, value_tag, envelope_version
      FROM runtime.credentials
      WHERE agent_key = 'panda' AND env_key = 'GITHUB_TOKEN'
    `);
    const swapped = source.rows[0]!;
    await pool.query(`
      UPDATE runtime.credentials
      SET value_ciphertext = $1, value_iv = $2, value_tag = $3, envelope_version = $4
      WHERE agent_key = 'panda' AND env_key = 'OPENAI_API_KEY'
    `, [swapped.value_ciphertext, swapped.value_iv, swapped.value_tag, swapped.envelope_version]);

    await expect(credentialResolver.resolveCredential("OPENAI_API_KEY", {agentKey: "panda"})).rejects.toThrow();
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

  it("encrypts values at rest and returns plaintext-free masked previews through the service", async () => {
    const {agentStore, credentialService, credentialStore} = await createHarness();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
    });

    const stored = await credentialService.setCredential({
      envKey: "OPENAI_API_KEY",
      value: "sk-live-339398484",
      agentKey: "panda",
    });
    expect(stored).toMatchObject({
      agentKey: "panda",
      envKey: "OPENAI_API_KEY",
      envelopeVersion: 2,
    });
    expect(stored).not.toHaveProperty("value");

    const raw = await credentialStore.getCredential("OPENAI_API_KEY", {
      agentKey: "panda",
    });
    expect(raw).not.toBeNull();
    expect(raw?.valueCiphertext.equals(Buffer.from("sk-live-339398484", "utf8"))).toBe(false);

    const preview = await credentialService.resolveCredential("OPENAI_API_KEY", {
      agentKey: "panda",
    });
    expect(preview).toMatchObject({envKey: "OPENAI_API_KEY", valuePreview: "sk-l...8484"});
    expect(preview).not.toHaveProperty("value");
    await expect(credentialService.listCredentialMetadata({agentKey: "panda"})).resolves.toEqual([
      expect.not.objectContaining({value: expect.anything()}),
    ]);
  });

  it("rejects corrupted persisted key versions before credential resolution", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: "00000000-0000-0000-0000-000000000001",
        env_key: "OPENAI_API_KEY",
        agent_key: "panda",
        value_ciphertext: Buffer.from("ciphertext"),
        value_iv: Buffer.from("iv"),
        value_tag: Buffer.from("tag"),
        envelope_version: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }],
    }));
    const pool = {
      query,
      connect: async () => {
        throw new Error("connect should not be used by getCredential");
      },
    };
    const credentialStore = new PostgresCredentialStore({pool});

    await expect(credentialStore.getCredential("OPENAI_API_KEY", {
      agentKey: "panda",
    })).rejects.toThrow("Credential envelope version must be a positive integer.");
  });

  it("rejects driver-shaped persisted key versions before credential resolution", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: "00000000-0000-0000-0000-000000000001",
        env_key: "OPENAI_API_KEY",
        agent_key: "panda",
        value_ciphertext: Buffer.from("ciphertext"),
        value_iv: Buffer.from("iv"),
        value_tag: Buffer.from("tag"),
        envelope_version: "2",
        created_at: new Date(),
        updated_at: new Date(),
      }],
    }));
    const pool = {
      query,
      connect: async () => {
        throw new Error("connect should not be used by getCredential");
      },
    };
    const credentialStore = new PostgresCredentialStore({pool});

    await expect(credentialStore.getCredential("OPENAI_API_KEY", {
      agentKey: "panda",
    })).rejects.toThrow("Credential envelope version must be a positive integer.");
  });

  it("rejects stringified persisted credential timestamps before credential resolution", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: "00000000-0000-0000-0000-000000000001",
        env_key: "OPENAI_API_KEY",
        agent_key: "panda",
        value_ciphertext: Buffer.from("ciphertext"),
        value_iv: Buffer.from("iv"),
        value_tag: Buffer.from("tag"),
        envelope_version: 2,
        created_at: "2026-05-01T12:00:00.000Z",
        updated_at: new Date(),
      }],
    }));
    const pool = {
      query,
      connect: async () => {
        throw new Error("connect should not be used by getCredential");
      },
    };
    const credentialStore = new PostgresCredentialStore({pool});

    await expect(credentialStore.getCredential("OPENAI_API_KEY", {
      agentKey: "panda",
    })).rejects.toThrow("Credential created_at must be a valid timestamp.");
  });

  it("migrates old credential rows by preserving relationship rows when no agent row exists", async () => {
    const {
      agentStore,
      credentialResolver,
      credentialStore,
      pool,
    } = await createHarness({ensureCredentialSchema: false});
    const crypto = new SecretCrypto("test-master-key");
    const encryptAgent = crypto.seal("agent-token", {purpose: "agent-credential", identity: ["panda", "NOTION_API_KEY"]});
    const encryptRelationship = crypto.seal("relationship-token", {purpose: "agent-credential", identity: ["panda", "NOTION_API_KEY"]});
    const encryptRelationshipOnly = crypto.seal("relationship-only-token", {purpose: "agent-credential", identity: ["panda", "GOOGLE_MAPS_API_KEY"]});

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
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
        envelope_version SMALLINT NOT NULL,
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
        envelope_version
      ) VALUES
        ($1, 'NOTION_API_KEY', 'relationship', 'panda', 'alice-id', $2, $3, $4, $5),
        ($6, 'NOTION_API_KEY', 'agent', 'panda', NULL, $7, $8, $9, $10),
        ($11, 'GOOGLE_MAPS_API_KEY', 'relationship', 'panda', 'alice-id', $12, $13, $14, $15)
    `, [
      "00000000-0000-0000-0000-000000000001",
      encryptRelationship.ciphertext,
      encryptRelationship.iv,
      encryptRelationship.tag,
      encryptRelationship.envelopeVersion,
      "00000000-0000-0000-0000-000000000002",
      encryptAgent.ciphertext,
      encryptAgent.iv,
      encryptAgent.tag,
      encryptAgent.envelopeVersion,
      "00000000-0000-0000-0000-000000000003",
      encryptRelationshipOnly.ciphertext,
      encryptRelationshipOnly.iv,
      encryptRelationshipOnly.tag,
      encryptRelationshipOnly.envelopeVersion,
    ]);

    await ensurePostgresCredentialSchema(pool);

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
    await expect(credentialResolver.resolveCredential("GOOGLE_MAPS_API_KEY", {
      agentKey: "panda",
    })).resolves.toMatchObject({
      value: "relationship-only-token",
    });

    const count = await pool.query("SELECT COUNT(*)::int AS count FROM runtime.credentials");
    expect(count.rows[0]?.count).toBe(2);
  });
});
