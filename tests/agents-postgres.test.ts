import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_DOCUMENT_TEMPLATES, PostgresAgentStore, PostgresIdentityStore,} from "../src/index.js";

describe("PostgresAgentStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createStores() {
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

    const identityStore = new PostgresIdentityStore({ pool });
    const agentStore = new PostgresAgentStore({ pool });
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();

    return {
      pool,
      identityStore,
      agentStore,
    };
  }

  it("bootstraps schema with repeatable CREATE IF NOT EXISTS statements", async () => {
    const queries: string[] = [];
    const store = new PostgresAgentStore({
      pool: {
        query: async (sql: string) => {
          queries.push(sql);
          return { rows: [] };
        },
        connect: async () => ({
          query: async () => ({ rows: [] }),
          release: () => {},
        }),
      },
    });

    await store.ensureSchema();
    await store.ensureSchema();

    expect(queries).toHaveLength(12);
    expect(queries.every((query) => query.includes("IF NOT EXISTS"))).toBe(true);
  });

  it("bootstraps agents with shared documents and lists them", async () => {
    const { agentStore } = await createStores();

    const created = await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      documents: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });

    expect(created).toMatchObject({
      agentKey: "panda",
      displayName: "Panda",
      status: "active",
    });
    await expect(agentStore.getAgent("panda")).resolves.toMatchObject({
      agentKey: "panda",
      displayName: "Panda",
    });
    await expect(agentStore.listAgents()).resolves.toEqual([
      expect.objectContaining({
        agentKey: "panda",
      }),
    ]);
    await expect(agentStore.readAgentDocument("panda", "agent")).resolves.toMatchObject({
      slug: "agent",
      content: DEFAULT_AGENT_DOCUMENT_TEMPLATES.agent,
    });
  });

  it("isolates relationship memory by identity and keeps diary unique per day", async () => {
    const { pool, identityStore, agentStore } = await createStores();
    await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await identityStore.createIdentity({
      id: "bob-id",
      handle: "bob",
      displayName: "Bob",
    });
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      documents: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });

    await agentStore.setRelationshipDocument("panda", "alice-id", "memory", "Alice likes tea.");
    await agentStore.setRelationshipDocument("panda", "bob-id", "memory", "Bob likes coffee.");

    await expect(agentStore.readRelationshipDocument("panda", "alice-id", "memory")).resolves.toMatchObject({
      content: "Alice likes tea.",
    });
    await expect(agentStore.readRelationshipDocument("panda", "bob-id", "memory")).resolves.toMatchObject({
      content: "Bob likes coffee.",
    });

    const firstDiary = await agentStore.setDiaryEntry("panda", "alice-id", "2026-04-10", "Met for dinner.");
    const updatedDiary = await agentStore.setDiaryEntry("panda", "alice-id", "2026-04-10", "Changed plans.");
    expect(updatedDiary.entryDate).toBe("2026-04-10");
    expect(updatedDiary.content).toBe("Changed plans.");
    expect(updatedDiary.updatedAt).toBeGreaterThanOrEqual(firstDiary.updatedAt);
    await expect(agentStore.listDiaryEntries("panda", "alice-id", 7)).resolves.toEqual([
      expect.objectContaining({
        entryDate: "2026-04-10",
        content: "Changed plans.",
      }),
    ]);

    const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM thread_runtime_agent_diary");
    expect(countResult.rows[0]?.count).toBe(1);
  });
});
