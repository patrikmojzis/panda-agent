import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";
import {mkdir, mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    buildPandaLlmContexts,
    DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    gatherContexts,
    PostgresAgentStore,
    PostgresIdentityStore,
} from "../src/index.js";

describe("buildPandaLlmContexts", () => {
  const pools: Array<{ end(): Promise<void> }> = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop() ?? "", { recursive: true, force: true });
    }
  });

  async function createFixture() {
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
    await agentStore.setRelationshipDocument("panda", "alice-id", "memory", "Alice likes tea.");
    await agentStore.setDiaryEntry("panda", "alice-id", "2026-04-10", "Met for dinner.");

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "panda-llm-contexts-"));
    tempDirs.push(tempDir);
    const skillDir = path.join(tempDir, "calendar");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "skill.md"), "Use this for calendar work.");

    return {
      agentStore,
      context: {
        cwd: "/workspace/panda",
        timezone: "UTC",
      },
      skillsDir: tempDir,
    };
  }

  it("keeps the full agent workspace in default Panda contexts", async () => {
    const fixture = await createFixture();

    const dump = await gatherContexts(buildPandaLlmContexts({
      context: fixture.context,
      agentStore: fixture.agentStore,
      agentKey: "panda",
      identityId: "alice-id",
      skillsDir: fixture.skillsDir,
    }));

    expect(dump).toContain("**Current DateTime:**");
    expect(dump).toContain("**Environment Overview:**");
    expect(dump).toContain("**Agent Workspace:**");
    expect(dump).toContain("Alice likes tea.");
    expect(dump).toContain("calendar\nUse this for calendar work.");
  });

  it("can limit Panda contexts to datetime and environment only", async () => {
    const fixture = await createFixture();

    const dump = await gatherContexts(buildPandaLlmContexts({
      context: fixture.context,
      agentStore: fixture.agentStore,
      agentKey: "panda",
      identityId: "alice-id",
      skillsDir: fixture.skillsDir,
      sections: ["datetime", "environment"],
    }));

    expect(dump).toContain("**Current DateTime:**");
    expect(dump).toContain("**Environment Overview:**");
    expect(dump).not.toContain("**Agent Workspace:**");
    expect(dump).not.toContain("Alice likes tea.");
  });
});
