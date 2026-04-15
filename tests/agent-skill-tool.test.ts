import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {Agent, AgentSkillTool, type PandaSessionContext, RunContext, ToolError,} from "../src/index.js";
import {DEFAULT_AGENT_DOCUMENT_TEMPLATES, PostgresAgentStore,} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";

function createRunContext(context: PandaSessionContext): RunContext<PandaSessionContext> {
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
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await store.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
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
