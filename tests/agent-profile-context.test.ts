import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {AgentProfileContext} from "../src/index.js";
import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore,} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";

describe("AgentProfileContext", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("loads shared prompts and skill summaries", async () => {
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
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await agentStore.setAgentPrompt(
      "panda",
      "agent",
      `${DEFAULT_AGENT_PROMPT_TEMPLATES.agent}\n\nBe kind.`,
    );
    await agentStore.setAgentSkill("panda", "calendar", "Use this for calendar work.", "# Calendar\nLong skill body.", ["calendar", "coding"]);

    const context = new AgentProfileContext({
      store: agentStore,
      agentKey: "panda",
    });
    const content = await context.getContent();

    expect(content).toContain("[agent]");
    expect(content).toContain(DEFAULT_AGENT_PROMPT_TEMPLATES.agent);
    expect(content).toContain("Be kind.");
    expect(content).not.toContain("[soul]");
    expect(content).toContain("Summaries only. Query `session.agent_skills` for full skill bodies when you need the exact content.");
    expect(content).toContain("calendar [calendar, coding]: Use this for calendar work.");
    expect(content).not.toContain("Long skill body.");
    expect(content).not.toContain("[memory]");
    expect(content).not.toContain("[recent diary]");
  });

  it("injects legacy persisted skill descriptions over 255 characters", async () => {
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
    const legacyDescription = "x".repeat(300);

    const identityStore = new PostgresIdentityStore({ pool });
    const agentStore = new PostgresAgentStore({ pool });
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await pool.query(`
      INSERT INTO runtime.agent_skills (agent_key, skill_key, description, content, tags)
      VALUES ('panda', 'legacy', $1, '# Legacy', $2::text[])
    `, [legacyDescription, []]);

    const context = new AgentProfileContext({
      store: agentStore,
      agentKey: "panda",
    });
    const content = await context.getContent();

    expect(content).toContain(`legacy: ${legacyDescription}`);
    expect(content).not.toContain("# Legacy");
  });

  it("filters injected skill summaries by execution environment skill allowlist", async () => {
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
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });
    await agentStore.setAgentSkill("panda", "calendar", "Use this for calendar work.", "# Calendar", ["calendar"]);
    await agentStore.setAgentSkill("panda", "finance", "Use this for finance work.", "# Finance", ["finance"]);

    const context = new AgentProfileContext({
      store: agentStore,
      agentKey: "panda",
      skillPolicy: {
        mode: "allowlist",
        skillKeys: ["calendar"],
      },
    });
    const content = await context.getContent();

    expect(content).toContain("calendar [calendar]: Use this for calendar work.");
    expect(content).not.toContain("finance [finance]: Use this for finance work.");
  });
});
