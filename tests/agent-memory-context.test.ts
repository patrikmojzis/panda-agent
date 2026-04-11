import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {AgentMemoryContext} from "../src/index.js";
import {DEFAULT_AGENT_DOCUMENT_TEMPLATES, PostgresAgentStore,} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";

describe("AgentMemoryContext", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("loads shared docs, relationship memory, diary, and skill instructions", async () => {
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
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      documents: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.setAgentDocument("panda", "soul", "Be kind.");
    await agentStore.setRelationshipDocument("panda", "alice-id", "memory", "Alice likes tea.");
    await agentStore.setDiaryEntry("panda", "alice-id", "2026-04-09", "Old entry.");
    await agentStore.setDiaryEntry("panda", "alice-id", "2026-04-10", "New entry.");
    await agentStore.setAgentSkill("panda", "calendar", "Use this for calendar work.", "# Calendar\nLong skill body.");

    const context = new AgentMemoryContext({
      store: agentStore,
      agentKey: "panda",
      identityId: "alice-id",
    });
    const content = await context.getContent();

    expect(content).toContain("[agent]");
    expect(content).toContain(DEFAULT_AGENT_DOCUMENT_TEMPLATES.agent);
    expect(content).toContain("[soul]");
    expect(content).toContain("Be kind.");
    expect(content).toContain("[memory]");
    expect(content).toContain("Alice likes tea.");
    expect(content).toContain("2026-04-09\nOld entry.\n\n2026-04-10\nNew entry.");
    expect(content).toContain("Summaries only. Query `panda_agent_skills` for full skill bodies when you need the exact content.");
    expect(content).toContain("calendar\nUse this for calendar work.");
    expect(content).not.toContain("Long skill body.");
  });
});
