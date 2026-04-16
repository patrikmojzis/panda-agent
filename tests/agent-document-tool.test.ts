import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {
    Agent,
    AgentDocumentTool,
    type DefaultAgentSessionContext,
    RunContext,
    ToolError,
    type ToolResultPayload,
} from "../src/index.js";
import {DEFAULT_AGENT_DOCUMENT_TEMPLATES, PostgresAgentStore,} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import type {AgentStore} from "../src/domain/agents/store.js";

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

function resolveSystemLocalDate(now: Date): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) {
    throw new Error(`Failed to resolve local date for timezone ${timeZone}.`);
  }

  return `${year}-${month}-${day}`;
}

describe("AgentDocumentTool", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
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
    const agentStore = new PostgresAgentStore({ pool });
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
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
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.setRelationshipDocument("panda", "alice-id", "memory", "Alice memory.");
    await agentStore.setRelationshipDocument("panda", "bob-id", "memory", "Bob memory.");
    await agentStore.setAgentDocument("ops", "agent", "Ops persona.");

    return agentStore;
  }

  it("reads documents using the current session's agent scope", async () => {
    const store = await createStore();
    const tool = new AgentDocumentTool({ store });

    const relationshipResult = await tool.run({
      target: "relationship",
      slug: "memory",
      operation: "read",
      identityId: "alice-id",
    }, createRunContext({
      identityId: "alice-id",
      agentKey: "panda",
    })) as ToolResultPayload;

    expect(parseToolResult(relationshipResult)).toMatchObject({
      target: "relationship",
      identityId: "alice-id",
      agentKey: "panda",
      slug: "memory",
      content: "Alice memory.",
    });

    const agentResult = await tool.run({
      target: "agent",
      slug: "agent",
      operation: "read",
    }, createRunContext({
      identityId: "alice-id",
      agentKey: "ops",
    })) as ToolResultPayload;

    expect(parseToolResult(agentResult)).toMatchObject({
      target: "agent",
      agentKey: "ops",
      slug: "agent",
      content: "Ops persona.",
    });
  });

  it("supports safe transforms for relationship memory", async () => {
    const store = await createStore();
    const tool = new AgentDocumentTool({ store });
    const context = createRunContext({
      identityId: "alice-id",
      agentKey: "panda",
    });

    const transformed = await tool.run({
      target: "relationship",
      slug: "memory",
      operation: "transform",
      identityId: "alice-id",
      expression: "concat(content, '\nSecond line.')",
    }, context) as ToolResultPayload;
    expect(parseToolResult(transformed)).toMatchObject({
      content: "Alice memory.\nSecond line.",
    });
  });

  it("rejects raw-sql style transforms", async () => {
    const store = await createStore();
    const tool = new AgentDocumentTool({ store });

    await expect(tool.run({
      target: "relationship",
      slug: "memory",
      operation: "transform",
      expression: "select * from runtime.messages",
    }, createRunContext({
      identityId: "alice-id",
      agentKey: "panda",
    }))).rejects.toBeInstanceOf(ToolError);
  });

  it("defaults diary writes to the current local day in the system timezone", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-04-10T23:30:00.000Z");
    vi.setSystemTime(now);

    const diaryEntries = new Map<string, string>();
    const fakeStore: AgentStore = {
      ensureSchema: async () => {},
      bootstrapAgent: async () => { throw new Error("not needed"); },
      getAgent: async () => { throw new Error("not needed"); },
      listAgents: async () => [],
      listAgentSkills: async () => [],
      readAgentSkill: async () => null,
      setAgentSkill: async () => { throw new Error("not needed"); },
      deleteAgentSkill: async () => { throw new Error("not needed"); },
      readAgentDocument: async () => null,
      setAgentDocument: async () => { throw new Error("not needed"); },
      transformAgentDocument: async () => { throw new Error("not needed"); },
      readRelationshipDocument: async () => null,
      setRelationshipDocument: async () => { throw new Error("not needed"); },
      transformRelationshipDocument: async () => { throw new Error("not needed"); },
      readDiaryEntry: async (_agentKey, entryDate) => {
        const content = diaryEntries.get(entryDate);
        return content === undefined
          ? null
          : {
            agentKey: "panda",
            identityId: "alice-id",
            entryDate,
            content,
            createdAt: 1,
            updatedAt: 1,
          };
      },
      setDiaryEntry: async (_agentKey, entryDate, content) => {
        diaryEntries.set(entryDate, content);
        return {
          agentKey: "panda",
          identityId: "alice-id",
          entryDate,
          content,
          createdAt: 1,
          updatedAt: 1,
        };
      },
      transformDiaryEntry: async () => { throw new Error("not needed"); },
      listDiaryEntries: async () => [],
    };
    const tool = new AgentDocumentTool({ store: fakeStore });

    await tool.run({
      target: "diary",
      operation: "set",
      content: "Diary for today.",
    }, createRunContext({
      identityId: "alice-id",
      agentKey: "panda",
    }));

    expect(diaryEntries.get(resolveSystemLocalDate(now))).toBe("Diary for today.");
  });

  it("describes diary defaults in system-timezone language", async () => {
    const tool = new AgentDocumentTool({
      store: await createStore(),
    });

    expect(tool.piTool.parameters).toMatchObject({
      properties: {
        date: {
          description: "Only for diary. Defaults to the current local day in YYYY-MM-DD using the current system timezone.",
        },
      },
    });
  });
});
