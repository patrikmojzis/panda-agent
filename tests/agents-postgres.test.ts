import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_DOCUMENT_TEMPLATES, PostgresAgentStore,} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";

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

  it("bootstraps schema with repeatable DDL statements", async () => {
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

    expect(queries).toHaveLength(18);
    expect(queries.filter((query) => query.includes("IF NOT EXISTS"))).toHaveLength(14);
    expect(queries.filter((query) => query.includes("ALTER COLUMN description DROP DEFAULT"))).toHaveLength(2);
    expect(queries.filter((query) => query.includes("ALTER COLUMN content DROP DEFAULT"))).toHaveLength(2);
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

  it("stores agent skills by agent key and cascades them on agent delete", async () => {
    const { pool, agentStore } = await createStores();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      documents: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      documents: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });

    const created = await agentStore.setAgentSkill(
      "panda",
      "calendar",
      "Use this for calendar work.",
      "# Calendar\nFull skill body.",
    );
    const updated = await agentStore.setAgentSkill(
      "panda",
      "calendar",
      "Updated description.",
      "# Calendar\nUpdated skill body.",
    );
    await agentStore.setAgentSkill(
      "ops",
      "calendar",
      "Ops-only description.",
      "# Ops Calendar\nOther skill body.",
    );

    expect(created.skillKey).toBe("calendar");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    await expect(agentStore.readAgentSkill("panda", "calendar")).resolves.toMatchObject({
      skillKey: "calendar",
      description: "Updated description.",
      content: "# Calendar\nUpdated skill body.",
    });
    await expect(agentStore.listAgentSkills("panda")).resolves.toEqual([
      expect.objectContaining({
        skillKey: "calendar",
        description: "Updated description.",
      }),
    ]);
    await expect(agentStore.listAgentSkills("ops")).resolves.toEqual([
      expect.objectContaining({
        skillKey: "calendar",
        description: "Ops-only description.",
      }),
    ]);

    expect(await agentStore.deleteAgentSkill("panda", "calendar")).toBe(true);
    expect(await agentStore.deleteAgentSkill("panda", "calendar")).toBe(false);
    await expect(agentStore.readAgentSkill("panda", "calendar")).resolves.toBeNull();

    await agentStore.setAgentSkill(
      "panda",
      "travel",
      "Travel planning skill.",
      "# Travel\nBody.",
    );
    await pool.query("DELETE FROM thread_runtime_agents WHERE agent_key = 'panda'");

    const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM thread_runtime_agent_skills");
    expect(countResult.rows[0]?.count).toBe(1);
    await expect(agentStore.readAgentSkill("ops", "calendar")).resolves.toMatchObject({
      description: "Ops-only description.",
    });
  });

  it("rejects blank content and oversized descriptions when storing agent skills", async () => {
    const { agentStore } = await createStores();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      documents: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });

    await expect(agentStore.setAgentSkill(
      "panda",
      "calendar",
      "   ",
      "# Calendar",
    )).rejects.toThrow("Skill description must not be empty.");

    await expect(agentStore.setAgentSkill(
      "panda",
      "calendar",
      "Calendar helper.",
      "   ",
    )).rejects.toThrow("Skill content must not be empty.");

    await expect(agentStore.setAgentSkill(
      "panda",
      "calendar",
      "x".repeat(8_001),
      "# Calendar",
    )).rejects.toThrow("Skill description must be at most 8000 characters.");
  });
});
