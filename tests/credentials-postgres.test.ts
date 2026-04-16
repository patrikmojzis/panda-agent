import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {
    CredentialCrypto,
    CredentialResolver,
    CredentialService,
    PostgresCredentialStore,
} from "../src/domain/credentials/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";

describe("PostgresCredentialStore", () => {
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

    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const credentialStore = new PostgresCredentialStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await credentialStore.ensureSchema();

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
      identityStore,
    };
  }

  it("stores one row per exact scope and resolves relationship before agent before identity", async () => {
    const {
      agentStore,
      credentialResolver,
      credentialService,
      credentialStore,
      identityStore,
      pool,
    } = await createHarness();

    await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });

    await credentialService.setCredential({
      envKey: "NOTION_API_KEY",
      value: "identity-token",
      scope: "identity",
      identityId: "alice-id",
    });
    await credentialService.setCredential({
      envKey: "NOTION_API_KEY",
      value: "agent-token",
      scope: "agent",
      agentKey: "panda",
    });
    await credentialService.setCredential({
      envKey: "NOTION_API_KEY",
      value: "relationship-token",
      scope: "relationship",
      agentKey: "panda",
      identityId: "alice-id",
    });
    await credentialService.setCredential({
      envKey: "NOTION_API_KEY",
      value: "relationship-token-updated",
      scope: "relationship",
      agentKey: "panda",
      identityId: "alice-id",
    });

    await expect(credentialResolver.resolveCredential("NOTION_API_KEY", {
      agentKey: "panda",
      identityId: "alice-id",
    })).resolves.toMatchObject({
      scope: "relationship",
      value: "relationship-token-updated",
    });
    await expect(credentialResolver.resolveCredential("NOTION_API_KEY", {
      agentKey: "panda",
    })).resolves.toMatchObject({
      scope: "agent",
      value: "agent-token",
    });
    await expect(credentialResolver.resolveCredential("NOTION_API_KEY", {
      identityId: "alice-id",
    })).resolves.toMatchObject({
      scope: "identity",
      value: "identity-token",
    });
    await expect(credentialResolver.resolveEnvironment({
      agentKey: "panda",
      identityId: "alice-id",
    })).resolves.toEqual({
      NOTION_API_KEY: "relationship-token-updated",
    });

    expect(await credentialStore.deleteCredential("NOTION_API_KEY", {
      scope: "relationship",
      agentKey: "panda",
      identityId: "alice-id",
    })).toBe(true);
    await expect(credentialResolver.resolveCredential("NOTION_API_KEY", {
      agentKey: "panda",
      identityId: "alice-id",
    })).resolves.toMatchObject({
      scope: "agent",
      value: "agent-token",
    });

    const count = await pool.query("SELECT COUNT(*)::int AS count FROM runtime.credentials");
    expect(count.rows[0]?.count).toBe(2);
  });

  it("rejects blocked env keys before storage", async () => {
    const {credentialService} = await createHarness();

    await expect(credentialService.setCredential({
      envKey: "PATH",
      value: "nope",
      scope: "agent",
      agentKey: "panda",
    })).rejects.toThrow("not allowed");

    await expect(credentialService.setCredential({
      envKey: "DATABASE_URL",
      value: "nope",
      scope: "identity",
      identityId: "local",
    })).rejects.toThrow("reserved");
  });

  it("encrypts values at rest and returns masked previews through the service", async () => {
    const {agentStore, credentialService, credentialStore, identityStore} = await createHarness();

    await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: {},
    });

    await credentialService.setCredential({
      envKey: "OPENAI_API_KEY",
      value: "sk-live-339398484",
      scope: "relationship",
      agentKey: "panda",
      identityId: "alice-id",
    });

    const raw = await credentialStore.getCredentialExact("OPENAI_API_KEY", {
      scope: "relationship",
      agentKey: "panda",
      identityId: "alice-id",
    });
    expect(raw).not.toBeNull();
    expect(raw?.valueCiphertext.equals(Buffer.from("sk-live-339398484", "utf8"))).toBe(false);

    await expect(credentialService.listCredentials({
      scope: "relationship",
      agentKey: "panda",
      identityId: "alice-id",
    })).resolves.toEqual([
      expect.objectContaining({
        envKey: "OPENAI_API_KEY",
        valuePreview: "sk-l...8484",
      }),
    ]);
  });
});
