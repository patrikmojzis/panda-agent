import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {resetSessionCurrentThread} from "../src/domain/sessions/index.js";
import {MAX_SESSION_TODO_ITEMS} from "../src/domain/sessions/todos.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

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

describe("session todos in Postgres", () => {
  const pools: Array<{end(): Promise<void>}> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      await pools.pop()?.end();
    }
  });

  it("stores, updates, clears, isolates, and cascades session todo context", async () => {
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

    await expect(sessionStore.readSessionTodo("session-one")).resolves.toBeNull();

    const created = await sessionStore.replaceSessionTodo({
      sessionId: "session-one",
      items: [
        {status: "in_progress", content: "  Inspect   current path  "},
        {status: "pending", content: "Write tests"},
      ],
    });
    expect(created).toMatchObject({
      sessionId: "session-one",
      items: [
        {status: "in_progress", content: "Inspect current path"},
        {status: "pending", content: "Write tests"},
      ],
    });
    expect(created?.itemsHash).toMatch(/^[0-9a-f]{64}$/);
    await expect(sessionStore.readSessionTodo("session-two")).resolves.toBeNull();

    const updated = await sessionStore.replaceSessionTodo({
      sessionId: "session-one",
      items: [
        {status: "done", content: "Inspect current path"},
      ],
    });
    expect(updated?.items).toEqual([
      {status: "done", content: "Inspect current path"},
    ]);
    expect(updated?.itemsHash).not.toBe(created?.itemsHash);

    await expect(sessionStore.replaceSessionTodo({
      sessionId: "session-one",
      items: [],
    })).resolves.toBeNull();
    await expect(sessionStore.readSessionTodo("session-one")).resolves.toBeNull();

    await sessionStore.replaceSessionTodo({
      sessionId: "session-two",
      items: [{status: "blocked", content: "Wait for approval"}],
    });
    await pool.query(`DELETE FROM "runtime"."agent_sessions" WHERE id = $1`, ["session-two"]);
    await expect(sessionStore.readSessionTodo("session-two")).resolves.toBeNull();
  });

  it("fails loudly when clearing todo context for a missing session", async () => {
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);

    await expect(sessionStore.replaceSessionTodo({
      sessionId: "missing-session",
      items: [],
    })).rejects.toThrow("Unknown session missing-session");
  });

  it("rejects invalid todo status, blank content, overlong content, and excessive lists", async () => {
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);

    await sessionStore.createSession({
      id: "session-validation",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-validation",
    });

    await expect(sessionStore.replaceSessionTodo({
      sessionId: "session-validation",
      items: [{status: "waiting", content: "Nope"}] as any,
    })).rejects.toThrow("unsupported status");
    await expect(sessionStore.replaceSessionTodo({
      sessionId: "session-validation",
      items: [{status: "pending", content: "   "}],
    })).rejects.toThrow("must not be empty");
    await expect(sessionStore.replaceSessionTodo({
      sessionId: "session-validation",
      items: [{status: "pending", content: "x".repeat(501)}],
    })).rejects.toThrow("at most 500");
    await expect(sessionStore.replaceSessionTodo({
      sessionId: "session-validation",
      items: Array.from({length: MAX_SESSION_TODO_ITEMS + 1}, (_, index) => ({
        status: "pending" as const,
        content: `todo ${index}`,
      })),
    })).rejects.toThrow("at most 100");
  });

  it("keeps todo context when reset creates a new current thread", async () => {
    const {pool, sessionStore, threadStore} = await createHarness();
    pools.push(pool);

    await sessionStore.createSession({
      id: "session-reset",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-before",
    });
    await sessionStore.replaceSessionTodo({
      sessionId: "session-reset",
      items: [{status: "pending", content: "Survive reset"}],
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
    await expect(sessionStore.readSessionTodo("session-reset")).resolves.toMatchObject({
      items: [{status: "pending", content: "Survive reset"}],
    });
  });
});
