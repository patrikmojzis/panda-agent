import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {resetSessionCurrentThread} from "../src/domain/sessions/index.js";

async function createHarness() {
  const db = newDb({noAstCoverageCheck: true});
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();
  const stores = await createRuntimeStores(pool);
  return {pool, ...stores};
}

describe("session prompts in Postgres", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("stores, updates, lists, isolates, deletes, and cascades session briefing prompts", async () => {
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);

    await sessionStore.createSession({
      id: "session-one",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-one",
    });
    await sessionStore.createSession({
      id: "session-two",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-two",
    });

    await expect(sessionStore.readSessionPrompt("session-one")).resolves.toBeNull();

    const created = await sessionStore.setSessionPrompt({
      sessionId: "session-one",
      content: "Use the release checklist.",
    });
    expect(created).toMatchObject({
      sessionId: "session-one",
      slug: "session",
      content: "Use the release checklist.",
    });
    await expect(sessionStore.readSessionPrompt("session-one")).resolves.toMatchObject({
      content: "Use the release checklist.",
    });
    await expect(sessionStore.readSessionPrompt("session-two")).resolves.toBeNull();
    await expect(sessionStore.listSessionPrompts("session-one")).resolves.toHaveLength(1);

    const updated = await sessionStore.setSessionPrompt({
      sessionId: "session-one",
      content: "Use the incident checklist.",
    });
    expect(updated.content).toBe("Use the incident checklist.");
    await expect(sessionStore.readSessionPrompt("session-one")).resolves.toMatchObject({
      content: "Use the incident checklist.",
    });

    await expect(sessionStore.deleteSessionPrompt({sessionId: "session-one"})).resolves.toBe(true);
    await expect(sessionStore.readSessionPrompt("session-one")).resolves.toBeNull();
    await expect(sessionStore.deleteSessionPrompt({sessionId: "session-one"})).resolves.toBe(false);

    await sessionStore.setSessionPrompt({
      sessionId: "session-two",
      content: "Stay scoped to session two.",
    });
    await pool.query(`DELETE FROM "runtime"."agent_sessions" WHERE id = $1`, ["session-two"]);
    await expect(sessionStore.listSessionPrompts("session-two")).resolves.toHaveLength(0);
  });

  it("keeps a session briefing prompt when reset creates a new current thread", async () => {
    const {pool, sessionStore, threadStore} = await createHarness();
    pools.push(pool);

    await sessionStore.createSession({
      id: "session-reset",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-before",
    });
    await sessionStore.setSessionPrompt({
      sessionId: "session-reset",
      content: "Reset must not erase this.",
    });

    await resetSessionCurrentThread({
      pool,
      sessionStore,
      threadStore,
      thread: {
        id: "thread-after",
        sessionId: "session-reset",
      },
      session: {
        sessionId: "session-reset",
        currentThreadId: "thread-after",
      },
    });

    await expect(sessionStore.getSession("session-reset")).resolves.toMatchObject({
      currentThreadId: "thread-after",
    });
    await expect(sessionStore.readSessionPrompt("session-reset")).resolves.toMatchObject({
      content: "Reset must not erase this.",
    });
  });
});
