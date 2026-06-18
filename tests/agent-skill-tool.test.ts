import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {Agent, AgentSkillTool, type DefaultAgentSessionContext, RunContext, ToolError,} from "../src/index.js";
import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore,} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "panda",
      instructions: "Use tools.",
    }),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

describe("AgentSkillTool", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  async function createStoreWithPool() {
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
    const store = new PostgresAgentStore({ pool });
    await identityStore.ensureSchema();
    await store.ensureSchema();
    await store.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await store.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });

    return {pool, store};
  }

  async function createStore() {
    return (await createStoreWithPool()).store;
  }

  it("describes tags as sparse discovery metadata, not a target", () => {
    const tool = new AgentSkillTool({
      store: {
        deleteAgentSkill: async () => { throw new Error("not used"); },
        loadAgentSkill: async () => { throw new Error("not used"); },
        setAgentSkill: async () => { throw new Error("not used"); },
      },
    });

    const parameters = tool.piTool.parameters as {properties: Record<string, {description?: string}>};
    const tagDescription = parameters.properties.tags?.description;

    expect(tagDescription).toContain("Prefer omitting tags unless they materially help discovery");
    expect(tagDescription).toContain("0-2 broad lowercase tags");
    expect(tagDescription).toContain("Max 20 tags is a hard cap, not a target");
  });

  it("upserts a skill on the current session agent", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    const result = await tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "Use this for calendar work.",
      content: "# Calendar\nLong skill body.",
      tags: [" Coding ", "repo:PANDA-agent", "coding"],
    }, createRunContext({
      agentKey: "panda",
    }));

    expect(result).toMatchObject({
      operation: "set",
      agentKey: "panda",
      skillKey: "calendar",
      description: "Use this for calendar work.",
      contentBytes: expect.any(Number),
      tags: ["coding", "repo:panda-agent"],
    });
    await expect(store.readAgentSkill("panda", "calendar")).resolves.toMatchObject({
      description: "Use this for calendar work.",
      content: "# Calendar\nLong skill body.",
      loadCount: 0,
      lastLoadedAt: undefined,
    });
  });

  it("loads the current session agent's full skill body and updates load metadata", async () => {
    const store = await createStore();
    await store.setAgentSkill("panda", "calendar", "Panda skill.", "# Panda", ["calendar", "coding"]);
    await store.setAgentSkill("ops", "calendar", "Ops skill.", "# Ops");
    const tool = new AgentSkillTool({ store });

    const firstLoad = await tool.run({
      operation: "load",
      skillKey: "calendar",
    }, createRunContext({
      agentKey: "panda",
    }));
    const secondLoad = await tool.run({
      operation: "load",
      skillKey: "calendar",
    }, createRunContext({
      agentKey: "panda",
    }));

    expect(firstLoad).toMatchObject({
      operation: "load",
      agentKey: "panda",
      skillKey: "calendar",
      found: true,
      description: "Panda skill.",
      content: "# Panda",
      contentBytes: expect.any(Number),
      tags: ["calendar", "coding"],
      loadCount: 1,
      lastLoadedAt: expect.any(Number),
    });
    expect(secondLoad).toMatchObject({
      operation: "load",
      agentKey: "panda",
      skillKey: "calendar",
      found: true,
      description: "Panda skill.",
      content: "# Panda",
      tags: ["calendar", "coding"],
      loadCount: 2,
      lastLoadedAt: expect.any(Number),
    });
    await expect(store.readAgentSkill("panda", "calendar")).resolves.toMatchObject({
      description: "Panda skill.",
      content: "# Panda",
      tags: ["calendar", "coding"],
      loadCount: 2,
      lastLoadedAt: expect.any(Number),
    });
    await expect(store.readAgentSkill("ops", "calendar")).resolves.toMatchObject({
      description: "Ops skill.",
      content: "# Ops",
      loadCount: 0,
      lastLoadedAt: undefined,
    });
  });

  it("loads legacy persisted descriptions over 255 characters", async () => {
    const {pool, store} = await createStoreWithPool();
    const legacyDescription = "x".repeat(300);
    const tool = new AgentSkillTool({ store });

    await pool.query(`
      INSERT INTO runtime.agent_skills (agent_key, skill_key, description, content, tags)
      VALUES ('panda', 'legacy', $1, '# Legacy', $2::text[])
    `, [legacyDescription, []]);

    await expect(tool.run({
      operation: "load",
      skillKey: "legacy",
    }, createRunContext({
      agentKey: "panda",
    }))).resolves.toMatchObject({
      operation: "load",
      found: true,
      skillKey: "legacy",
      description: legacyDescription,
      content: "# Legacy",
      loadCount: 1,
    });
  });

  it("blocks skills outside the execution environment allowlist", async () => {
    const store = await createStore();
    await store.setAgentSkill("panda", "calendar", "Panda skill.", "# Panda");
    await store.setAgentSkill("panda", "finance", "Finance skill.", "# Finance");
    const tool = new AgentSkillTool({ store });
    const context = createRunContext({
      agentKey: "panda",
      executionEnvironment: {
        id: "worker:session",
        agentKey: "panda",
        kind: "disposable_container",
        state: "ready",
        executionMode: "remote",
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "allowlist", skillKeys: ["calendar"]},
        toolPolicy: {},
        source: "binding",
      },
    });

    await expect(tool.run({
      operation: "load",
      skillKey: "calendar",
    }, context)).resolves.toMatchObject({
      found: true,
      skillKey: "calendar",
    });
    await expect(tool.run({
      operation: "load",
      skillKey: "finance",
    }, context)).rejects.toThrow("Skill finance is not allowed in this execution environment.");
  });

  it("blocks skill mutation in constrained execution environments", async () => {
    const store = await createStore();
    await store.setAgentSkill("panda", "calendar", "Panda skill.", "# Panda");
    const tool = new AgentSkillTool({ store });
    const context = createRunContext({
      agentKey: "panda",
      executionEnvironment: {
        id: "worker:session",
        agentKey: "panda",
        kind: "disposable_container",
        state: "ready",
        executionMode: "remote",
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "allowlist", skillKeys: ["calendar"]},
        toolPolicy: {},
        source: "binding",
      },
    });

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "Updated.",
      content: "# Updated",
    }, context)).rejects.toThrow("Skill mutation is not allowed in this execution environment.");
    await expect(tool.run({
      operation: "delete",
      skillKey: "calendar",
    }, context)).rejects.toThrow("Skill mutation is not allowed in this execution environment.");
  });

  it("returns a non-throwing miss for load", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    await expect(tool.run({
      operation: "load",
      skillKey: "missing",
    }, createRunContext({
      agentKey: "panda",
    }))).resolves.toEqual({
      operation: "load",
      agentKey: "panda",
      skillKey: "missing",
      found: false,
    });
  });

  it("deletes only the current session agent's skill", async () => {
    const store = await createStore();
    await store.setAgentSkill("panda", "calendar", "Panda skill.", "# Panda");
    await store.setAgentSkill("ops", "calendar", "Ops skill.", "# Ops");
    const tool = new AgentSkillTool({ store });

    const result = await tool.run({
      operation: "delete",
      skillKey: "calendar",
    }, createRunContext({
      agentKey: "panda",
    }));

    expect(result).toEqual({
      operation: "delete",
      agentKey: "panda",
      skillKey: "calendar",
      deleted: true,
    });
    await expect(store.readAgentSkill("panda", "calendar")).resolves.toBeNull();
    await expect(store.readAgentSkill("ops", "calendar")).resolves.toMatchObject({
      description: "Ops skill.",
    });
  });

  it("requires description and content for set", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      content: "# Calendar",
    }, createRunContext({
      agentKey: "panda",
    }))).rejects.toBeInstanceOf(ToolError);
  });

  it("rejects tags for load and delete operations", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    await expect(tool.run({
      operation: "load",
      skillKey: "calendar",
      tags: ["coding"],
    }, createRunContext({
      agentKey: "panda",
    }))).rejects.toThrow("Load does not take tags.");

    await expect(tool.run({
      operation: "delete",
      skillKey: "calendar",
      tags: ["coding"],
    }, createRunContext({
      agentKey: "panda",
    }))).rejects.toThrow("Delete does not take tags.");
  });

  it("rejects blank description or content for set", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "   ",
      content: "# Calendar",
    }, createRunContext({
      agentKey: "panda",
    }))).rejects.toThrow("Skill description must not be empty.");

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "Calendar helper.",
      content: "   ",
    }, createRunContext({
      agentKey: "panda",
    }))).rejects.toThrow("Skill content must not be empty.");
  });

  it("rejects invalid tags for set", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "Calendar helper.",
      content: "# Calendar",
      tags: [""],
    }, createRunContext({
      agentKey: "panda",
    }))).rejects.toThrow("Skill tags must not be empty.");

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "Calendar helper.",
      content: "# Calendar",
      tags: ["repo/panda-agent"],
    }, createRunContext({
      agentKey: "panda",
    }))).rejects.toThrow("Skill tags must use lowercase letters, numbers, hyphens, underscores, or colons.");
  });

  it("rejects descriptions over 255 characters for set", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "x".repeat(255),
      content: "# Calendar",
    }, createRunContext({
      agentKey: "panda",
    }))).resolves.toMatchObject({description: "x".repeat(255)});

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "x".repeat(256),
      content: "# Calendar",
    }, createRunContext({
      agentKey: "panda",
    }))).rejects.toThrow("Skill description must be at most 255 characters.");
  });


  it("enforces operation-aware tool policy before skill store access", async () => {
    const store = await createStore();
    await store.setAgentSkill("panda", "calendar", "Panda skill.", "# Panda", ["calendar", "coding"]);
    const tool = new AgentSkillTool({ store });
    const loadOnlyContext = createRunContext({
      agentKey: "panda",
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      sessionKind: "subagent",
      executionEnvironment: {
        id: "local:panda",
        agentKey: "panda",
        kind: "local",
        state: "ready",
        executionMode: "local",
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          agentSkill: {allowedOperations: ["load"]},
        },
        source: "fallback",
      },
    });

    await expect(tool.run({
      operation: "load",
      skillKey: "calendar",
    }, loadOnlyContext)).resolves.toMatchObject({
      operation: "load",
      found: true,
      tags: ["calendar", "coding"],
    });
    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "Updated.",
      content: "# Updated",
    }, loadOnlyContext)).rejects.toThrow("agent_skill(set) is not allowed in this execution environment.");
    await expect(tool.run({
      operation: "delete",
      skillKey: "calendar",
    }, loadOnlyContext)).rejects.toThrow("agent_skill(delete) is not allowed in this execution environment.");
    await expect(store.readAgentSkill("panda", "calendar")).resolves.toMatchObject({
      content: "# Panda",
    });
  });

  it("allows skill maintenance operations under the narrow operation grant", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });
    const maintenanceContext = createRunContext({
      agentKey: "panda",
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      sessionKind: "subagent",
      executionEnvironment: {
        id: "local:panda",
        agentKey: "panda",
        kind: "local",
        state: "ready",
        executionMode: "local",
        credentialPolicy: {mode: "allowlist", envKeys: []},
        skillPolicy: {mode: "all_agent"},
        toolPolicy: {
          agentSkill: {allowedOperations: ["load", "set", "delete"]},
        },
        source: "fallback",
      },
    });

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "Calendar helper.",
      content: "# Calendar",
    }, maintenanceContext)).resolves.toMatchObject({
      operation: "set",
      skillKey: "calendar",
    });
    await expect(tool.run({
      operation: "delete",
      skillKey: "calendar",
    }, maintenanceContext)).resolves.toMatchObject({
      operation: "delete",
      deleted: true,
    });
  });

  it("fails closed for subagent mutation when operation policy is absent or malformed", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });
    const baseContext = {
      agentKey: "panda",
      sessionId: "subagent-session",
      threadId: "subagent-thread",
      sessionKind: "subagent" as const,
      executionEnvironment: {
        id: "local:panda",
        agentKey: "panda",
        kind: "local" as const,
        state: "ready" as const,
        executionMode: "local" as const,
        credentialPolicy: {mode: "allowlist" as const, envKeys: []},
        skillPolicy: {mode: "all_agent" as const},
        toolPolicy: {},
        source: "fallback" as const,
      },
    };

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "Calendar helper.",
      content: "# Calendar",
    }, createRunContext(baseContext))).rejects.toThrow("agent_skill(set) is not allowed in this execution environment.");
    await expect(tool.run({
      operation: "delete",
      skillKey: "calendar",
    }, createRunContext({
      ...baseContext,
      executionEnvironment: {
        ...baseContext.executionEnvironment,
        toolPolicy: {
          agentSkill: {allowedOperations: "set" as never},
        },
      },
    }))).rejects.toThrow("agent_skill(delete) is not allowed in this execution environment.");
  });

  it("requires agentKey in the run context", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    await expect(tool.run({
      operation: "delete",
      skillKey: "calendar",
    }, createRunContext({}))).rejects.toBeInstanceOf(ToolError);
  });
});
