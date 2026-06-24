import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";
import {PostgresSessionStore, resetSessionCurrentThread} from "../src/domain/sessions/index.js";

class DropViewRecordingPool {
  readonly droppedViews: string[] = [];

  constructor(
    private readonly pool: {
      connect(): Promise<any>;
      query(text: string, values?: readonly unknown[]): Promise<any>;
    },
  ) {}

  connect(): Promise<any> {
    return this.pool.connect();
  }

  async query(text: string, values?: readonly unknown[]): Promise<any> {
    if (/^\s*DROP VIEW "session"\."agent_prompts"\s*;?\s*$/i.test(text)) {
      this.droppedViews.push(text);
      return {rows: [], rowCount: 0, command: "DROP"};
    }
    return this.pool.query(text, values);
  }
}

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

  it("stores, updates, lists, isolates, deletes, and cascades session prompts", async () => {
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
      slug: "brief",
      content: "Use the release checklist.",
    });
    await expect(sessionStore.readSessionPrompt("session-one")).resolves.toMatchObject({
      content: "Use the release checklist.",
    });
    await expect(sessionStore.readSessionPrompt("session-two")).resolves.toBeNull();
    await sessionStore.setSessionPrompt({
      sessionId: "session-one",
      slug: "memory",
      content: "The user prefers short answers.",
    });
    await sessionStore.setSessionPrompt({
      sessionId: "session-one",
      slug: "heartbeat",
      content: "Check blockers.",
    });
    await expect(sessionStore.listSessionPrompts("session-one")).resolves.toMatchObject([
      {slug: "brief"},
      {slug: "heartbeat"},
      {slug: "memory"},
    ]);

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
    await expect(sessionStore.deleteSessionPrompt({sessionId: "session-one", slug: "memory"})).resolves.toBe(true);
    await expect(sessionStore.readSessionPrompt("session-one", "memory")).resolves.toBeNull();

    await sessionStore.setSessionPrompt({
      sessionId: "session-two",
      content: "Stay scoped to session two.",
    });
    await pool.query(`DELETE FROM "runtime"."agent_sessions" WHERE id = $1`, ["session-two"]);
    await expect(sessionStore.listSessionPrompts("session-two")).resolves.toHaveLength(0);
  });

  it("rejects old prompt slugs", async () => {
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);

    await sessionStore.createSession({
      id: "session-one",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-one",
    });

    await expect(sessionStore.setSessionPrompt({
      sessionId: "session-one",
      slug: "session" as never,
      content: "Old slug.",
    })).rejects.toThrow("Unsupported session prompt slug session.");
  });

  it("repairs legacy agent and session prompt storage into session prompts", async () => {
    const db = newDb({noAstCoverageCheck: true});
    db.public.registerFunction({
      name: "pg_notify",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: () => "",
    });
    db.public.registerFunction({
      name: "btrim",
      args: [DataType.text],
      returns: DataType.text,
      implementation: (value: string) => value.trim(),
    });
    db.public.registerFunction({
      name: "nullif",
      args: [DataType.text, DataType.text],
      returns: DataType.text,
      implementation: (value: string, nullValue: string) => value === nullValue ? null : value,
    });
    const adapter = db.adapters.createPg();
    const pool = new adapter.Pool();
    pools.push(pool);
    const {agentStore} = await createRuntimeStores(pool);

    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
    });
    await pool.query(`
      INSERT INTO "runtime"."agent_sessions" (id, agent_key, kind, current_thread_id)
      VALUES
        ('panda-main', 'panda', 'main', 'thread-main'),
        ('panda-branch', 'panda', 'branch', 'thread-branch'),
        ('panda-subagent', 'panda', 'subagent', 'thread-subagent')
    `);
    await pool.query(`
      INSERT INTO "runtime"."session_prompts" (session_id, slug, content)
      VALUES
        ('panda-main', 'session', 'Session brief.'),
        ('panda-branch', 'session', 'Branch brief.'),
        ('panda-subagent', 'session', 'Subagent brief.')
    `);
    await pool.query(`
      CREATE TABLE "runtime"."agent_prompts" (
        agent_key TEXT NOT NULL,
        slug TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, slug)
      )
    `);
    await pool.query(`
      INSERT INTO "runtime"."agent_prompts" (agent_key, slug, content)
      VALUES
        ('panda', 'agent', 'Agent persona.'),
        ('panda', 'heartbeat', 'Heartbeat guidance.'),
        ('ops', 'agent', 'Ops persona.')
    `);
    await pool.query(`CREATE SCHEMA "session"`);
    await pool.query(`
      CREATE VIEW "session"."agent_prompts" AS
      SELECT agent_key, slug, content
      FROM "runtime"."agent_prompts"
    `);

    const migrationPool = new DropViewRecordingPool(pool);
    const migrationSessionStore = new PostgresSessionStore({pool: migrationPool});
    await migrationSessionStore.ensureSchema();

    expect(migrationPool.droppedViews).toHaveLength(1);
    await expect(migrationSessionStore.readSessionPrompt("panda-main", "brief")).resolves.toMatchObject({
      content: "Agent persona.\n\nSession brief.",
    });
    await expect(migrationSessionStore.readSessionPrompt("panda-branch", "brief")).resolves.toMatchObject({
      content: "Agent persona.\n\nBranch brief.",
    });
    await expect(migrationSessionStore.readSessionPrompt("panda-main", "heartbeat")).resolves.toMatchObject({
      content: "Heartbeat guidance.",
    });
    await expect(migrationSessionStore.readSessionPrompt("panda-main", "memory")).resolves.toBeNull();
    await expect(migrationSessionStore.listSessionPrompts("panda-subagent")).resolves.toEqual([]);

    const legacyRows = await pool.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM "runtime"."session_prompts"
      WHERE slug = 'session'
    `);
    expect(legacyRows.rows[0]).toEqual({count: 0});
    const legacyTable = await pool.query(`
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'runtime'
        AND table_name = 'agent_prompts'
    `);
    expect(legacyTable.rows).toHaveLength(0);
  });

  it("does not leave an empty prompt row when transform fails", async () => {
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);

    await sessionStore.createSession({
      id: "session-one",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-one",
    });

    await expect(sessionStore.transformSessionPrompt({
      sessionId: "session-one",
      slug: "memory",
      expression: "missing_function(content)",
    })).rejects.toThrow();
    await expect(sessionStore.readSessionPrompt("session-one", "memory")).resolves.toBeNull();
  });

  it("transforms prompts from the latest stored content", async () => {
    const {pool, sessionStore} = await createHarness();
    pools.push(pool);

    await sessionStore.createSession({
      id: "session-one",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "thread-one",
    });
    await sessionStore.setSessionPrompt({
      sessionId: "session-one",
      slug: "memory",
      content: "first",
    });

    await expect(sessionStore.transformSessionPrompt({
      sessionId: "session-one",
      slug: "memory",
      expression: "content || ' second'",
    })).resolves.toMatchObject({
      content: "first second",
    });
    await expect(sessionStore.transformSessionPrompt({
      sessionId: "session-one",
      slug: "memory",
      expression: "content || ' third'",
    })).resolves.toMatchObject({
      content: "first second third",
    });
  });

  it("keeps a session prompt when reset creates a new current thread", async () => {
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
