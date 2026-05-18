import {randomUUID} from "node:crypto";

import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresConnectorAccountStore} from "../src/domain/connectors/index.js";
import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";

describe("PostgresConnectorAccountStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createHarness() {
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
    const connectorStore = new PostgresConnectorAccountStore({pool});
    const identityStore = new PostgresIdentityStore({pool});
    await connectorStore.ensureSchema();

    return {
      agentStore,
      connectorStore,
      identityStore,
      pool,
    };
  }

  it("keeps account keys idempotent and connector keys unique per source", async () => {
    const {connectorStore, pool} = await createHarness();

    const created = await connectorStore.upsertAccount({
      source: "discord",
      accountKey: "ops",
      connectorKey: "bot-1",
      displayName: "Ops Discord",
    });
    const updated = await connectorStore.upsertAccount({
      source: "discord",
      accountKey: "ops",
      connectorKey: "bot-1-renamed",
      status: "disabled",
    });

    expect(updated.id).toBe(created.id);
    await expect(connectorStore.listAccounts({source: "discord"})).resolves.toEqual([
      expect.objectContaining({
        accountKey: "ops",
        connectorKey: "bot-1-renamed",
        status: "disabled",
        ownerKind: "system",
      }),
    ]);
    await expect(connectorStore.getAccountByConnectorKey("discord", "bot-1-renamed")).resolves.toMatchObject({
      accountKey: "ops",
    });
    await expect(pool.query(`
      INSERT INTO runtime.connector_accounts (
        id,
        source,
        account_key,
        connector_key
      ) VALUES ($1, $2, $3, $4)
    `, [randomUUID(), "discord", "ops", "bot-duplicate-account"])).rejects.toThrow();

    await expect(connectorStore.upsertAccount({
      source: "discord",
      accountKey: "support",
      connectorKey: "bot-1-renamed",
    })).rejects.toThrow();
  });

  it("enforces exclusive owner constraints and owner foreign keys", async () => {
    const {agentStore, connectorStore, identityStore, pool} = await createHarness();

    await identityStore.createIdentity({
      id: "patrik-id",
      handle: "patrik",
      displayName: "Patrik",
    });
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });

    await expect(connectorStore.upsertAccount({
      source: "discord",
      accountKey: "owned-by-identity",
      connectorKey: "bot-identity",
      ownerIdentityId: "patrik-id",
    })).resolves.toMatchObject({
      ownerKind: "identity",
      ownerIdentityId: "patrik-id",
      ownerAgentKey: null,
    });
    await expect(connectorStore.upsertAccount({
      source: "discord",
      accountKey: "owned-by-agent",
      connectorKey: "bot-agent",
      ownerAgentKey: "panda",
    })).resolves.toMatchObject({
      ownerKind: "agent",
      ownerIdentityId: null,
      ownerAgentKey: "panda",
    });
    await expect(connectorStore.upsertAccount({
      source: "discord",
      accountKey: "invalid-owner-flags",
      connectorKey: "bot-invalid-flags",
      ownerIdentityId: "patrik-id",
      ownerAgentKey: "panda",
    })).rejects.toThrow("exclusive");

    await expect(pool.query(`
      INSERT INTO runtime.connector_accounts (
        id,
        source,
        account_key,
        connector_key,
        owner_kind,
        owner_identity_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [randomUUID(), "discord", "bad-owner", "bot-bad-owner", "system", "patrik-id"])).rejects.toThrow();

    await expect(pool.query(`
      INSERT INTO runtime.connector_accounts (
        id,
        source,
        account_key,
        connector_key,
        owner_kind,
        owner_identity_id
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [randomUUID(), "discord", "missing-identity", "bot-missing-identity", "identity", "missing-id"])).rejects.toThrow();

    await expect(pool.query(`
      INSERT INTO runtime.connector_accounts (
        id,
        source,
        account_key,
        connector_key,
        owner_kind,
        owner_agent_key
      ) VALUES ($1, $2, $3, $4, $5, $6)
    `, [randomUUID(), "discord", "missing-agent", "bot-missing-agent", "agent", "missing-agent"])).rejects.toThrow();
  });

  it("round-trips encrypted connector secrets and returns null for missing secrets", async () => {
    const {connectorStore, pool} = await createHarness();
    const crypto = new CredentialCrypto("test-connector-master-key");
    const account = await connectorStore.upsertAccount({
      source: "discord",
      accountKey: "ops",
      connectorKey: "bot-1",
    });

    await connectorStore.setSecret(account.id, "bot_token", "dummy-token-roundtrip", crypto);

    await expect(connectorStore.getSecret(account.id, "bot_token", crypto)).resolves.toBe("dummy-token-roundtrip");
    await expect(connectorStore.getSecret(account.id, "missing_token", crypto)).resolves.toBeNull();
    await expect(connectorStore.getSecret(account.id, "bot_token", null)).rejects.toThrow("CredentialCrypto");

    const raw = await pool.query(`
      SELECT value_ciphertext
      FROM runtime.connector_account_secrets
      WHERE account_id = $1
        AND secret_key = $2
    `, [account.id, "bot_token"]);
    const ciphertext = raw.rows[0] as {value_ciphertext: Buffer};
    expect(ciphertext.value_ciphertext.equals(Buffer.from("dummy-token-roundtrip", "utf8"))).toBe(false);
  });

  it("does not expose plaintext or ciphertext in account list or secret summaries", async () => {
    const {connectorStore} = await createHarness();
    const crypto = new CredentialCrypto("test-connector-master-key");
    const account = await connectorStore.upsertAccount({
      source: "discord",
      accountKey: "ops",
      connectorKey: "bot-1",
      externalUsername: "ops-bot",
    });
    await connectorStore.setSecret(account.id, "bot_token", "dummy-token-never-listed", crypto);

    const listedAccounts = await connectorStore.listAccounts({source: "discord"});
    const inspectedAccount = await connectorStore.getAccountByKey("discord", "ops");
    const secretSummaries = await connectorStore.listSecretKeys(account.id);
    const safeOutput = JSON.stringify({
      listedAccounts,
      inspectedAccount,
      secretSummaries,
    });

    expect(safeOutput).not.toContain("dummy-token-never-listed");
    expect(safeOutput).not.toContain("valueCiphertext");
    expect(safeOutput).not.toContain("valueIv");
    expect(safeOutput).not.toContain("valueTag");
    expect(secretSummaries).toEqual([
      expect.objectContaining({
        accountId: account.id,
        secretKey: "bot_token",
      }),
    ]);
  });
});
