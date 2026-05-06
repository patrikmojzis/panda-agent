import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_PROMPT_TEMPLATES, PostgresAgentStore} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {PostgresSidecarRepo} from "../src/domain/sidecars/index.js";

function createPool() {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

describe("PostgresSidecarRepo", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("stores per-agent sidecar definitions", async () => {
    const pool = createPool();
    pools.push(pool);
    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sidecars = new PostgresSidecarRepo({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await sidecars.ensureSchema();
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

    const created = await sidecars.upsertDefinition({
      agentKey: "panda",
      sidecarKey: "memory_guard",
      displayName: "Memory Guard",
      enabled: true,
      prompt: "Check memory.",
      triggers: ["before_run_step", "after_run_finish"],
      model: "openai-codex/gpt-5.4",
      thinking: "high",
    });
    await sidecars.upsertDefinition({
      agentKey: "ops",
      sidecarKey: "memory_guard",
      prompt: "Ops only.",
      triggers: ["after_run_finish"],
    });

    expect(created).toMatchObject({
      agentKey: "panda",
      sidecarKey: "memory_guard",
      displayName: "Memory Guard",
      enabled: true,
      prompt: "Check memory.",
      triggers: ["before_run_step", "after_run_finish"],
      model: "openai-codex/gpt-5.4",
      thinking: "high",
      toolset: "readonly",
    });
    await expect(sidecars.listAgentDefinitions("panda")).resolves.toEqual([
      expect.objectContaining({
        agentKey: "panda",
        sidecarKey: "memory_guard",
      }),
    ]);

    await sidecars.setEnabled("panda", "memory_guard", false);
    await expect(sidecars.listAgentDefinitions("panda", {enabled: true})).resolves.toEqual([]);
    await expect(sidecars.listAgentDefinitions("ops", {enabled: true})).resolves.toHaveLength(1);
  });

  it("validates sidecar keys and required triggers", async () => {
    const pool = createPool();
    pools.push(pool);
    const identityStore = new PostgresIdentityStore({pool});
    const agentStore = new PostgresAgentStore({pool});
    const sidecars = new PostgresSidecarRepo({pool});
    await identityStore.ensureSchema();
    await agentStore.ensureSchema();
    await sidecars.ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "panda",
      displayName: "Panda",
      prompts: DEFAULT_AGENT_PROMPT_TEMPLATES,
    });

    await expect(sidecars.upsertDefinition({
      agentKey: "panda",
      sidecarKey: "Bad Key",
      prompt: "Nope.",
      triggers: ["after_run_finish"],
    })).rejects.toThrow(/Sidecar key/);
    await expect(sidecars.upsertDefinition({
      agentKey: "panda",
      sidecarKey: "memory_guard",
      prompt: "Nope.",
      triggers: [],
    })).rejects.toThrow(/at least one trigger/);
  });
});
