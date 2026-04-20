import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore,} from "../src/domain/agents/index.js";
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

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every((query) => query.includes("IF NOT EXISTS"))).toBe(true);
  });

  it("bootstraps agents with shared prompts and lists them", async () => {
    const { agentStore } = await createStores();

    const created = await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
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
    await expect(agentStore.readAgentPrompt("panda", "agent")).resolves.toMatchObject({
      slug: "agent",
      content: DEFAULT_AGENT_PROMPT_TEMPLATES.agent,
    });
  });

  it("stores pairings per identity and keeps prompts scoped by agent", async () => {
    const { identityStore, agentStore } = await createStores();
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
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await agentStore.ensurePairing("panda", "alice-id");
    await agentStore.ensurePairing("panda", "bob-id");
    await agentStore.setAgentPrompt("panda", "heartbeat", "Panda heartbeat.");
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await agentStore.setAgentPrompt("ops", "heartbeat", "Ops heartbeat.");

    await expect(agentStore.listAgentPairings("panda")).resolves.toEqual([
      expect.objectContaining({identityId: "alice-id"}),
      expect.objectContaining({identityId: "bob-id"}),
    ]);
    await expect(agentStore.readAgentPrompt("panda", "heartbeat")).resolves.toMatchObject({
      content: "Panda heartbeat.",
    });
    await expect(agentStore.readAgentPrompt("ops", "heartbeat")).resolves.toMatchObject({
      content: "Ops heartbeat.",
    });
  });

  it("stores agent skills by agent key and cascades them on agent delete", async () => {
    const { pool, agentStore } = await createStores();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
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
    expect(created.loadCount).toBe(0);
    expect(created.lastLoadedAt).toBeUndefined();
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    await expect(agentStore.readAgentSkill("panda", "calendar")).resolves.toMatchObject({
      skillKey: "calendar",
      description: "Updated description.",
      content: "# Calendar\nUpdated skill body.",
      loadCount: 0,
      lastLoadedAt: undefined,
    });
    const firstLoad = await agentStore.loadAgentSkill("panda", "calendar");
    const secondLoad = await agentStore.loadAgentSkill("panda", "calendar");
    expect(firstLoad).toMatchObject({
      skillKey: "calendar",
      loadCount: 1,
      lastLoadedAt: expect.any(Number),
    });
    expect(secondLoad).toMatchObject({
      skillKey: "calendar",
      loadCount: 2,
      lastLoadedAt: expect.any(Number),
    });
    await expect(agentStore.loadAgentSkill("panda", "missing")).resolves.toBeNull();
    await expect(agentStore.listAgentSkills("panda")).resolves.toEqual([
      expect.objectContaining({
        skillKey: "calendar",
        description: "Updated description.",
        loadCount: 2,
      }),
    ]);
    await expect(agentStore.listAgentSkills("ops")).resolves.toEqual([
      expect.objectContaining({
        skillKey: "calendar",
        description: "Ops-only description.",
        loadCount: 0,
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
    await pool.query("DELETE FROM runtime.agents WHERE agent_key = 'panda'");

    const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM runtime.agent_skills");
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
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
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
