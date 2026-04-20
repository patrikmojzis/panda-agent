import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {
  Agent,
  AgentPromptTool,
  type DefaultAgentSessionContext,
  RunContext,
  ToolError,
  type ToolResultPayload,
} from "../src/index.js";
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

function parseToolResult(result: ToolResultPayload): Record<string, unknown> {
  const textPart = result.content.find((part) => part.type === "text");
  if (!textPart) {
    throw new Error("Expected text output.");
  }

  return JSON.parse(textPart.text) as Record<string, unknown>;
}

describe("AgentPromptTool", () => {
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

    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
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
    await agentStore.setAgentPrompt("ops", "agent", "Ops persona.");

    return agentStore;
  }

  it("reads prompts using the current session's agent scope", async () => {
    const store = await createStore();
    const tool = new AgentPromptTool({store});

    const result = await tool.run({
      slug: "agent",
      operation: "read",
    }, createRunContext({
      identityId: "alice-id",
      agentKey: "ops",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      agentKey: "ops",
      slug: "agent",
      operation: "read",
      content: "Ops persona.",
      exists: true,
    });
  });

  it("supports safe transforms for prompts", async () => {
    const store = await createStore();
    const tool = new AgentPromptTool({store});
    const context = createRunContext({
      identityId: "alice-id",
      agentKey: "panda",
    });

    const transformed = await tool.run({
      slug: "heartbeat",
      operation: "transform",
      expression: "concat(content, '\nSecond line.')",
    }, context) as ToolResultPayload;

    expect(parseToolResult(transformed)).toMatchObject({
      slug: "heartbeat",
      content: `${DEFAULT_AGENT_PROMPT_TEMPLATES.heartbeat}\nSecond line.`,
    });
  });

  it("rejects raw-sql style transforms", async () => {
    const store = await createStore();
    const tool = new AgentPromptTool({store});

    await expect(tool.run({
      slug: "agent",
      operation: "transform",
      expression: "select * from runtime.messages",
    }, createRunContext({
      identityId: "alice-id",
      agentKey: "panda",
    }))).rejects.toBeInstanceOf(ToolError);
  });

  it("fails fast when agentKey is missing from the runtime context", async () => {
    const store = await createStore();
    const tool = new AgentPromptTool({store});

    await expect(tool.run({
      slug: "agent",
      operation: "read",
    }, createRunContext({
      identityId: "alice-id",
    }))).rejects.toThrow("The agent prompt tool requires agentKey in the runtime session context.");
  });
});
