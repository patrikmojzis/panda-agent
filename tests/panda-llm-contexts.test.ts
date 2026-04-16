import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {buildDefaultAgentLlmContexts, gatherContexts,} from "../src/index.js";
import {DEFAULT_AGENT_DOCUMENT_TEMPLATES, PostgresAgentStore,} from "../src/domain/agents/index.js";
import {PostgresIdentityStore} from "../src/domain/identity/index.js";
import {TestThreadRuntimeStore} from "./helpers/test-runtime-store.js";

describe("buildDefaultAgentLlmContexts", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
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
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.setRelationshipDocument("panda", "alice-id", "memory", "Alice likes tea.");
    await agentStore.setDiaryEntry("panda", "alice-id", "2026-04-10", "Met for dinner.");
    await agentStore.setAgentSkill("panda", "calendar", "Use this for calendar work.", "# Calendar\nLong skill body.");

    return {
      agentStore,
      context: {
        cwd: "/workspace/panda",
      },
    };
  }

  it("keeps the full agent profile in default Panda contexts", async () => {
    const fixture = await createFixture();

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: fixture.context,
      agentStore: fixture.agentStore,
      agentKey: "panda",
    }));

    expect(dump).toContain("**Current DateTime:**");
    expect(dump).toContain("**Environment Overview:**");
    expect(dump).toContain("**Agent Profile:**");
    expect(dump).toContain("Summaries only. Query `session.agent_skills` for full skill bodies when you need the exact content.");
    expect(dump).toContain("calendar\nUse this for calendar work.");
    expect(dump).not.toContain("Long skill body.");
    expect(dump).not.toContain("Alice likes tea.");
    expect(dump).not.toContain("Met for dinner.");
    expect(dump).not.toContain("**Heartbeat Guidance**");
  });

  it("can limit Panda contexts to datetime and environment only", async () => {
    const fixture = await createFixture();

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: fixture.context,
      agentStore: fixture.agentStore,
      agentKey: "panda",
      sections: ["datetime", "environment"],
    }));

    expect(dump).toContain("**Current DateTime:**");
    expect(dump).toContain("**Environment Overview:**");
    expect(dump).not.toContain("**Agent Profile:**");
    expect(dump).not.toContain("Alice likes tea.");
  });

  it("shows running background bash jobs in the default Panda contexts when available", async () => {
    const threadStore = new TestThreadRuntimeStore();
    await threadStore.createThread({
      id: "thread-bg-context",
      sessionId: "session-bg-context",
      context: {
        sessionId: "session-bg-context",
        agentKey: "panda",
      },
    });
    await threadStore.createBashJob({
      id: "job-running",
      threadId: "thread-bg-context",
      command: "sleep 10 && printf running",
      mode: "local",
      initialCwd: "/workspace/panda",
      startedAt: Date.now() - 1_500,
    });
    await threadStore.createBashJob({
      id: "job-done",
      threadId: "thread-bg-context",
      command: "printf done",
      mode: "local",
      initialCwd: "/workspace/panda",
      startedAt: Date.now() - 5_000,
      status: "completed",
    });

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {
        cwd: "/workspace/panda",
      },
      threadStore,
      threadId: "thread-bg-context",
    }));

    expect(dump).toContain("**Background Bash Jobs:**");
    expect(dump).toContain("job-running");
    expect(dump).toContain("sleep 10 && printf running");
    expect(dump).not.toContain("job-done");
  });

  it("omits the background bash section when no jobs are running", async () => {
    const threadStore = new TestThreadRuntimeStore();
    await threadStore.createThread({
      id: "thread-no-bg-context",
      sessionId: "session-no-bg-context",
      context: {
        sessionId: "session-no-bg-context",
        agentKey: "panda",
      },
    });
    await threadStore.createBashJob({
      id: "job-done",
      threadId: "thread-no-bg-context",
      command: "printf done",
      mode: "local",
      initialCwd: "/workspace/panda",
      startedAt: Date.now() - 5_000,
      status: "completed",
    });

    const dump = await gatherContexts(buildDefaultAgentLlmContexts({
      context: {
        cwd: "/workspace/panda",
      },
      threadStore,
      threadId: "thread-no-bg-context",
      sections: ["background_jobs"],
    }));

    expect(dump).toBe("");
  });
});
