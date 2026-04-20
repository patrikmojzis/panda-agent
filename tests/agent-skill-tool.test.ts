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

  async function createStore() {
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

    return store;
  }

  it("upserts a skill on the current session agent", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    const result = await tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "Use this for calendar work.",
      content: "# Calendar\nLong skill body.",
    }, createRunContext({
      agentKey: "panda",
    }));

    expect(result).toMatchObject({
      operation: "set",
      agentKey: "panda",
      skillKey: "calendar",
      description: "Use this for calendar work.",
      contentBytes: expect.any(Number),
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
    await store.setAgentSkill("panda", "calendar", "Panda skill.", "# Panda");
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
      loadCount: 2,
      lastLoadedAt: expect.any(Number),
    });
    await expect(store.readAgentSkill("panda", "calendar")).resolves.toMatchObject({
      description: "Panda skill.",
      content: "# Panda",
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

  it("rejects oversized descriptions for set", async () => {
    const store = await createStore();
    const tool = new AgentSkillTool({ store });

    await expect(tool.run({
      operation: "set",
      skillKey: "calendar",
      description: "x".repeat(8_001),
      content: "# Calendar",
    }, createRunContext({
      agentKey: "panda",
    }))).rejects.toThrow("Skill description must be at most 8000 characters.");
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
