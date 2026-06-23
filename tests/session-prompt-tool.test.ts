import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {
  Agent,
  type DefaultAgentSessionContext,
  RunContext,
  SessionPromptTool,
  ToolError,
  type ToolResultPayload,
} from "../src/index.js";
import {PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSessionStore} from "../src/domain/sessions/index.js";

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

describe("SessionPromptTool", () => {
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
    const sessionStore = new PostgresSessionStore({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await sessionStore.ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
    });
    await sessionStore.createSession({
      id: "session-panda",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-panda",
    });
    await sessionStore.createSession({
      id: "session-ops",
      agentKey: "ops",
      kind: "branch",
      currentThreadId: "thread-ops",
    });
    await sessionStore.setSessionPrompt({
      sessionId: "session-ops",
      slug: "brief",
      content: "Ops brief.",
    });

    return sessionStore;
  }

  it("reads prompts using only the current session scope", async () => {
    const store = await createStore();
    const tool = new SessionPromptTool({store});

    const result = await tool.run({
      slug: "brief",
      operation: "read",
    }, createRunContext({
      identityId: "alice-id",
      agentKey: "panda",
      sessionId: "session-ops",
    })) as ToolResultPayload;

    expect(parseToolResult(result)).toMatchObject({
      sessionId: "session-ops",
      slug: "brief",
      operation: "read",
      content: "Ops brief.",
      exists: true,
    });
  });

  it("supports safe transforms for prompts", async () => {
    const store = await createStore();
    await store.setSessionPrompt({
      sessionId: "session-panda",
      slug: "heartbeat",
      content: "Heartbeat.",
    });
    const tool = new SessionPromptTool({store});
    const context = createRunContext({
      identityId: "alice-id",
      agentKey: "panda",
      sessionId: "session-panda",
    });

    const transformed = await tool.run({
      slug: "heartbeat",
      operation: "transform",
      expression: "concat(content, '\nSecond line.')",
    }, context) as ToolResultPayload;

    expect(parseToolResult(transformed)).toMatchObject({
      slug: "heartbeat",
      sessionId: "session-panda",
      content: "Heartbeat.\nSecond line.",
    });
  });

  it("rejects raw-sql style transforms", async () => {
    const store = await createStore();
    const tool = new SessionPromptTool({store});

    await expect(tool.run({
      slug: "brief",
      operation: "transform",
      expression: "select * from runtime.messages",
    }, createRunContext({
      identityId: "alice-id",
      agentKey: "panda",
      sessionId: "session-panda",
    }))).rejects.toBeInstanceOf(ToolError);
  });

  it("fails fast when sessionId is missing from the runtime context", async () => {
    const store = await createStore();
    const tool = new SessionPromptTool({store});

    await expect(tool.run({
      slug: "brief",
      operation: "read",
    }, createRunContext({
      identityId: "alice-id",
    }))).rejects.toThrow("The session prompt tool requires sessionId in the runtime session context.");
  });
});
