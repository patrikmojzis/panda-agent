import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {
  DEFAULT_AGENT_PROMPT_TEMPLATES,
  PostgresAgentStore,
} from "../src/domain/agents/index.js";
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

  it("rejects non-json persisted agent metadata before returning records", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        agent_key: "panda",
        display_name: "Panda",
        status: "active",
        metadata: Number.NaN,
        created_at: new Date(),
        updated_at: new Date(),
      }],
    }));
    const agentStore = new PostgresAgentStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by getAgent");
        },
      },
    });

    await expect(agentStore.getAgent("panda")).rejects.toThrow(
      "Agent metadata must be JSON-serializable.",
    );
  });

  it("rejects corrupted persisted agent timestamps before returning records", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          agent_key: "panda",
          display_name: "Panda",
          status: "active",
          metadata: {},
          created_at: "eventually",
          updated_at: new Date(),
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          agent_key: "panda",
          identity_id: "identity-patrik",
          metadata: {},
          created_at: new Date(),
          updated_at: "eventually",
        }],
      });
    const agentStore = new PostgresAgentStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(agentStore.getAgent("panda")).rejects.toThrow(
      "Agent created_at must be a valid timestamp.",
    );
    await expect(agentStore.listAgentPairings("panda")).rejects.toThrow(
      "Agent pairing updated_at must be a valid timestamp.",
    );
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
      [" Coding ", "repo:PANDA-agent", "coding", "ui-ux", "project:ortoart"],
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
    expect(created.tags).toEqual(["coding", "repo:panda-agent", "ui-ux", "project:ortoart"]);
    expect(created.agentEditable).toBe(true);
    expect(created.loadCount).toBe(0);
    expect(created.lastLoadedAt).toBeUndefined();
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
    await expect(agentStore.readAgentSkill("panda", "calendar")).resolves.toMatchObject({
      skillKey: "calendar",
      description: "Updated description.",
      content: "# Calendar\nUpdated skill body.",
      agentEditable: true,
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
        tags: [],
        loadCount: 2,
      }),
    ]);
    await expect(agentStore.listAgentSkills("ops")).resolves.toEqual([
      expect.objectContaining({
        skillKey: "calendar",
        description: "Ops-only description.",
        tags: [],
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

  it("defaults legacy skills editable and guards agent-facing mutations when locked", async () => {
    const { pool, agentStore } = await createStores();

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await pool.query(`
      INSERT INTO runtime.agent_skills (agent_key, skill_key, description, content, tags)
      VALUES ('panda', 'legacy', 'Legacy skill.', '# Legacy', $1::text[])
    `, [[]]);

    await expect(agentStore.readAgentSkill("panda", "legacy")).resolves.toMatchObject({
      skillKey: "legacy",
      agentEditable: true,
    });

    const locked = await agentStore.setAgentSkill(
      "panda",
      "locked",
      "Locked skill.",
      "PRIVATE_LOCKED_CONTENT",
      [],
      {agentEditable: false},
    );
    expect(locked.agentEditable).toBe(false);

    const trustedUpdate = await agentStore.setAgentSkill(
      "panda",
      "locked",
      "Trusted update.",
      "PRIVATE_LOCKED_CONTENT_UPDATED",
    );
    expect(trustedUpdate.agentEditable).toBe(false);

    await expect(agentStore.loadAgentSkill("panda", "locked")).resolves.toMatchObject({
      skillKey: "locked",
      agentEditable: false,
      loadCount: 1,
    });
    await expect(agentStore.setAgentSkillAsAgent(
      "panda",
      "locked",
      "Agent update.",
      "# Agent update",
    )).rejects.toThrow("Skill is locked from agent edits.");
    await expect(agentStore.deleteAgentSkillAsAgent("panda", "locked")).rejects.toThrow("Skill is locked from agent edits.");
    await expect(agentStore.readAgentSkill("panda", "locked")).resolves.toMatchObject({
      description: "Trusted update.",
      content: "PRIVATE_LOCKED_CONTENT_UPDATED",
      agentEditable: false,
    });

    await expect(agentStore.setAgentSkill(
      "panda",
      "locked",
      "Unlocked skill.",
      "# Unlocked",
      [],
      {agentEditable: true},
    )).resolves.toMatchObject({agentEditable: true});
    await expect(agentStore.setAgentSkillAsAgent(
      "panda",
      "locked",
      "Agent update after unlock.",
      "# Agent update after unlock",
    )).resolves.toMatchObject({
      description: "Agent update after unlock.",
      agentEditable: true,
    });
    await expect(agentStore.deleteAgentSkillAsAgent("panda", "locked")).resolves.toBe(true);
  });

  it("rejects driver-shaped persisted agent skill load counts", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        agent_key: "panda",
        skill_key: "calendar",
        description: "Calendar skill.",
        content: "# Calendar\nBody.",
        last_loaded_at: null,
        load_count: "1",
        created_at: new Date(),
        updated_at: new Date(),
      }],
    }));
    const agentStore = new PostgresAgentStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by readAgentSkill");
        },
      },
    });

    await expect(agentStore.readAgentSkill("panda", "calendar")).rejects.toThrow(
      "Agent skill load count must be a non-negative integer.",
    );
  });

  it("rejects malformed persisted agent skill tags", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        agent_key: "panda",
        skill_key: "calendar",
        description: "Calendar skill.",
        content: "# Calendar\nBody.",
        tags: ["calendar", 123],
        last_loaded_at: null,
        load_count: 0,
        created_at: new Date(),
        updated_at: new Date(),
      }],
    }));
    const agentStore = new PostgresAgentStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by readAgentSkill");
        },
      },
    });

    await expect(agentStore.readAgentSkill("panda", "calendar")).rejects.toThrow(
      "Skill tags must be strings.",
    );
  });

  it("keeps legacy persisted long skill descriptions readable and loadable", async () => {
    const { pool, agentStore } = await createStores();
    const legacyDescription = "x".repeat(300);

    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await pool.query(`
      INSERT INTO runtime.agent_skills (agent_key, skill_key, description, content, tags)
      VALUES ('panda', 'legacy', $1, '# Legacy', $2::text[])
    `, [legacyDescription, []]);

    await expect(agentStore.readAgentSkill("panda", "legacy")).resolves.toMatchObject({
      skillKey: "legacy",
      description: legacyDescription,
      loadCount: 0,
    });
    await expect(agentStore.listAgentSkills("panda")).resolves.toEqual([
      expect.objectContaining({
        skillKey: "legacy",
        description: legacyDescription,
      }),
    ]);
    await expect(agentStore.loadAgentSkill("panda", "legacy")).resolves.toMatchObject({
      skillKey: "legacy",
      description: legacyDescription,
      loadCount: 1,
      lastLoadedAt: expect.any(Number),
    });
  });

  it("rejects blank content and descriptions over 255 characters when storing agent skills", async () => {
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
      "x".repeat(255),
      "# Calendar",
    )).resolves.toMatchObject({description: "x".repeat(255)});

    await expect(agentStore.setAgentSkill(
      "panda",
      "calendar",
      "x".repeat(256),
      "# Calendar",
    )).rejects.toThrow("Skill description must be at most 255 characters.");

    await expect(agentStore.setAgentSkill(
      "panda",
      "calendar",
      "Calendar helper.",
      "# Calendar",
      [""],
    )).rejects.toThrow("Skill tags must not be empty.");

    await expect(agentStore.setAgentSkill(
      "panda",
      "calendar",
      "Calendar helper.",
      "# Calendar",
      ["x".repeat(65)],
    )).rejects.toThrow("Skill tags must be at most 64 characters.");

    await expect(agentStore.setAgentSkill(
      "panda",
      "calendar",
      "Calendar helper.",
      "# Calendar",
      ["repo/panda-agent"],
    )).rejects.toThrow("Skill tags must use lowercase letters, numbers, hyphens, underscores, or colons.");
  });
});
