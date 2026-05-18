import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresWikiBindingStore} from "../src/domain/wiki/postgres.js";
import {WikiBindingService} from "../src/domain/wiki/service.js";

describe("PostgresWikiBindingStore", () => {
  const pools: Array<{end(): Promise<void>}> = [];

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
    const identityStore = new PostgresIdentityStore({pool});
    const wikiBindingStore = new PostgresWikiBindingStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await wikiBindingStore.ensureSchema();

    return {
      agentStore,
      pool,
      wikiBindingService: new WikiBindingService({
        store: wikiBindingStore,
        crypto: new CredentialCrypto("test-master-key"),
      }),
      wikiBindingStore,
    };
  }

  it("stores one encrypted wiki binding per agent and decrypts it through the service", async () => {
    const {agentStore, pool, wikiBindingService, wikiBindingStore} = await createHarness();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });

    await wikiBindingService.setBinding({
      agentKey: "panda",
      wikiGroupId: 7,
      namespacePath: "/agents/panda/",
      apiToken: "first-token",
    });
    const updated = await wikiBindingService.setBinding({
      agentKey: "panda",
      wikiGroupId: 8,
      namespacePath: "agents/panda",
      apiToken: "second-token",
    });

    expect(updated).toMatchObject({
      agentKey: "panda",
      wikiGroupId: 8,
      namespacePath: "agents/panda",
      apiToken: "second-token",
    });

    const raw = await wikiBindingStore.getBinding("panda");
    expect(raw).not.toBeNull();
    expect(raw?.apiTokenCiphertext.equals(Buffer.from("second-token", "utf8"))).toBe(false);

    await expect(wikiBindingService.getBinding("panda")).resolves.toMatchObject({
      agentKey: "panda",
      wikiGroupId: 8,
      namespacePath: "agents/panda",
      apiToken: "second-token",
    });

    const count = await pool.query("SELECT COUNT(*)::int AS count FROM runtime.agent_wiki_bindings");
    expect(count.rows[0]?.count).toBe(1);
  });

  it("clears stored bindings", async () => {
    const {agentStore, wikiBindingService} = await createHarness();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });
    await wikiBindingService.setBinding({
      agentKey: "panda",
      wikiGroupId: 7,
      namespacePath: "agents/panda",
      apiToken: "token",
    });

    await expect(wikiBindingService.clearBinding("panda")).resolves.toBe(true);
    await expect(wikiBindingService.getBinding("panda")).resolves.toBeNull();
  });

  it("rejects corrupted persisted wiki binding versions before decryption", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        agent_key: "panda",
        wiki_group_id: 7,
        namespace_path: "agents/panda",
        api_token_ciphertext: Buffer.from("ciphertext"),
        api_token_iv: Buffer.from("iv"),
        api_token_tag: Buffer.from("tag"),
        key_version: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }],
    }));
    const wikiBindingStore = new PostgresWikiBindingStore({
      pool: {query},
    });

    await expect(wikiBindingStore.getBinding("panda")).rejects.toThrow(
      "Wiki binding key version must be a positive integer.",
    );
  });

  it("rejects driver-shaped persisted wiki binding numbers before decryption", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        agent_key: "panda",
        wiki_group_id: "7",
        namespace_path: "agents/panda",
        api_token_ciphertext: Buffer.from("ciphertext"),
        api_token_iv: Buffer.from("iv"),
        api_token_tag: Buffer.from("tag"),
        key_version: 1,
        created_at: new Date(),
        updated_at: new Date(),
      }],
    }));
    const wikiBindingStore = new PostgresWikiBindingStore({
      pool: {query},
    });

    await expect(wikiBindingStore.getBinding("panda")).rejects.toThrow(
      "Wiki group id must be a positive integer.",
    );
  });

  it("rejects stringified persisted wiki binding timestamps before decryption", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        agent_key: "panda",
        wiki_group_id: 7,
        namespace_path: "agents/panda",
        api_token_ciphertext: Buffer.from("ciphertext"),
        api_token_iv: Buffer.from("iv"),
        api_token_tag: Buffer.from("tag"),
        key_version: 1,
        created_at: "2026-05-01T12:00:00.000Z",
        updated_at: new Date(),
      }],
    }));
    const wikiBindingStore = new PostgresWikiBindingStore({
      pool: {query},
    });

    await expect(wikiBindingStore.getBinding("panda")).rejects.toThrow(
      "Wiki binding created_at must be a valid timestamp.",
    );
  });
});
