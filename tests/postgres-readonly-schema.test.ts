import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {DEFAULT_AGENT_DOCUMENT_TEMPLATES,} from "../src/domain/agents/index.js";
import {ensureReadonlySessionQuerySchema} from "../src/domain/threads/runtime/index.js";
import {PostgresScheduledTaskStore} from "../src/domain/scheduling/tasks/index.js";
import {PostgresWatchStore} from "../src/domain/watches/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

class RecordingQueryable {
  readonly queries: string[] = [];

  async query(text: string): Promise<{ rows: never[] }> {
    this.queries.push(text);
    return { rows: [] };
  }
}

class PgMemReadonlySchemaQueryable {
  constructor(
    private readonly pool: { query(text: string): Promise<{ rows: unknown[] }> },
  ) {}

  async query(text: string): Promise<{ rows: unknown[] }> {
    const statements = text
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean);

    for (const statement of statements) {
      if (/^DROP VIEW IF EXISTS\b/i.test(statement)) {
        continue;
      }

      if (/^CREATE VIEW "session"."threads"/i.test(statement)) {
        const whereMatches = [...statement.matchAll(/\bWHERE\b/gi)];
        const whereIndex = whereMatches.at(-1)?.index;
        const whereClause = whereIndex === undefined
          ? undefined
          : statement.slice(whereIndex + "WHERE".length).trim();
        if (!whereClause) {
          throw new Error("Expected session.threads view SQL to contain a WHERE clause.");
        }

        await this.pool.query(`
          CREATE VIEW "session"."threads" AS
          SELECT
            t.id,
            t.session_id,
            session.agent_key
          FROM "runtime"."threads" AS t
          INNER JOIN "runtime"."agent_sessions" AS session
            ON session.id = t.session_id
          WHERE ${whereClause}
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."(messages_raw|messages|tool_results|inputs|runs)"/i.test(statement)) {
        continue;
      }

      if (/^CREATE VIEW "session"."scheduled_tasks"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."scheduled_tasks" AS
          SELECT
            scheduled_tasks.id,
            scheduled_tasks.session_id,
            scheduled_tasks.created_by_identity_id,
            session.current_thread_id AS resolved_thread_id
          FROM "runtime"."scheduled_tasks" AS scheduled_tasks
          INNER JOIN "runtime"."agent_sessions" AS session
            ON session.id = scheduled_tasks.session_id
          WHERE scheduled_tasks.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."scheduled_task_runs"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."scheduled_task_runs" AS
          SELECT
            scheduled_task_runs.id,
            scheduled_task_runs.task_id,
            scheduled_task_runs.session_id
          FROM "runtime"."scheduled_task_runs" AS scheduled_task_runs
          WHERE scheduled_task_runs.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."watches"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."watches" AS
          SELECT
            watch.id,
            watch.session_id,
            watch.created_by_identity_id,
            session.current_thread_id AS resolved_thread_id
          FROM "runtime"."watches" AS watch
          INNER JOIN "runtime"."agent_sessions" AS session
            ON session.id = watch.session_id
          WHERE watch.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."watch_runs"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."watch_runs" AS
          SELECT
            watch_runs.id,
            watch_runs.watch_id,
            watch_runs.session_id
          FROM "runtime"."watch_runs" AS watch_runs
          WHERE watch_runs.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "session"."watch_events"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "session"."watch_events" AS
          SELECT
            watch_events.id,
            watch_events.watch_id,
            watch_events.session_id
          FROM "runtime"."watch_events" AS watch_events
          WHERE watch_events.session_id = current_setting('runtime.session_id', true)
        `);
        continue;
      }

      const sanitized = statement.replace(
        /\bWITH\s*\(security_barrier\s*=\s*true\)\s+AS\b/gi,
        "AS",
      );
      await this.pool.query(sanitized);
    }

    return { rows: [] };
  }
}

function createScopedPool() {
  const db = newDb();
  const scope = new Map<string, string | null>();

  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  db.public.registerFunction({
    name: "current_setting",
    args: [DataType.text, DataType.bool],
    returns: DataType.text,
    implementation: (key: string) => scope.get(key) ?? null,
  });
  db.public.registerFunction({
    name: "convert_to",
    args: [DataType.text, DataType.text],
    returns: DataType.bytea,
    implementation: (value: string, encoding: string) => Buffer.from(value, encoding),
  });
  db.public.registerFunction({
    name: "octet_length",
    args: [DataType.bytea],
    returns: DataType.integer,
    implementation: (value: Buffer) => value.length,
  });

  const adapter = db.adapters.createPg();
  const pool = new adapter.Pool();

  return {
    pool,
    setScope(next: { sessionId?: string | null; agentKey?: string | null }) {
      scope.set("runtime.session_id", next.sessionId ?? null);
      scope.set("runtime.agent_key", next.agentKey ?? null);
    },
  };
}

describe("ensureReadonlySessionQuerySchema", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("creates split session views and grants access to them", async () => {
    const queryable = new RecordingQueryable();

    const views = await ensureReadonlySessionQuerySchema({
      queryable,
      readonlyRole: "readonly_user",
    });

    expect(views).toEqual({
      agentSessions: "\"session\".\"agent_sessions\"",
      threads: "\"session\".\"threads\"",
      messages: "\"session\".\"messages\"",
      messagesRaw: "\"session\".\"messages_raw\"",
      toolResults: "\"session\".\"tool_results\"",
      inputs: "\"session\".\"inputs\"",
      runs: "\"session\".\"runs\"",
      agentPrompts: "\"session\".\"agent_prompts\"",
      agentDocuments: "\"session\".\"agent_documents\"",
      agentDiary: "\"session\".\"agent_diary\"",
      agentPairings: "\"session\".\"agent_pairings\"",
      agentSkills: "\"session\".\"agent_skills\"",
      scheduledTasks: "\"session\".\"scheduled_tasks\"",
      scheduledTaskRuns: "\"session\".\"scheduled_task_runs\"",
      watches: "\"session\".\"watches\"",
      watchRuns: "\"session\".\"watch_runs\"",
      watchEvents: "\"session\".\"watch_events\"",
    });

    expect(queryable.queries).toHaveLength(2);
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_sessions\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"messages_raw\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"messages\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"tool_results\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_prompts\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_documents\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_diary\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_pairings\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"agent_skills\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"scheduled_tasks\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"scheduled_task_runs\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"watches\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"watch_runs\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"session\".\"watch_events\"");
    expect(queryable.queries[0]).toContain("FROM \"session\".\"messages_raw\" AS raw");
    expect(queryable.queries[0]).toContain("WHERE raw.role IN ('user', 'assistant')");
    expect(queryable.queries[0]).toContain("t.inference_projection");
    expect(queryable.queries[0]).toContain("t.session_id = current_setting('runtime.session_id', true)");
    expect(queryable.queries[0]).toContain("prompt.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[0]).toContain("document.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[0]).toContain("diary.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[0]).toContain("pairing.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[0]).toContain("skill.agent_key = current_setting('runtime.agent_key', true)");
    expect(queryable.queries[1]).toContain("GRANT SELECT ON \"session\".\"agent_sessions\", \"session\".\"threads\", \"session\".\"messages\", \"session\".\"messages_raw\", \"session\".\"tool_results\", \"session\".\"inputs\", \"session\".\"runs\", \"session\".\"agent_prompts\", \"session\".\"agent_documents\", \"session\".\"agent_diary\", \"session\".\"agent_pairings\", \"session\".\"agent_skills\", \"session\".\"scheduled_tasks\", \"session\".\"scheduled_task_runs\", \"session\".\"watches\", \"session\".\"watch_runs\", \"session\".\"watch_events\"");
  });

  it("filters readonly threads by session when multiple identities share an agent", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore, identityStore, sessionStore, threadStore: store} = await createRuntimeStores(pool);
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();

    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    const bob = await identityStore.createIdentity({
      id: "bob-id",
      handle: "bob",
      displayName: "Bob",
    });

    await sessionStore.createSession({
      id: "alice-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "alice-thread",
      createdByIdentityId: alice.id,
    });
    await sessionStore.createSession({
      id: "bob-session",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "bob-thread",
      createdByIdentityId: bob.id,
    });
    await store.createThread({
      id: "alice-thread",
      sessionId: "alice-session",
    });
    await store.createThread({
      id: "bob-thread",
      sessionId: "bob-session",
    });

    setScope({
      sessionId: "alice-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT id, session_id, agent_key FROM \"session\".\"threads\" ORDER BY id",
    );

    expect(result.rows).toEqual([
      {
        id: "alice-thread",
        session_id: "alice-session",
        agent_key: "panda",
      },
    ]);
  });

  it("filters readonly threads by agent when one identity has multiple agents", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore, identityStore, sessionStore, threadStore: store} = await createRuntimeStores(pool);
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();

    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });

    await sessionStore.createSession({
      id: "panda-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "alice-panda-thread",
      createdByIdentityId: alice.id,
    });
    await sessionStore.createSession({
      id: "ops-session",
      agentKey: "ops",
      kind: "main",
      currentThreadId: "alice-ops-thread",
      createdByIdentityId: alice.id,
    });
    await store.createThread({
      id: "alice-panda-thread",
      sessionId: "panda-session",
    });
    await store.createThread({
      id: "alice-ops-thread",
      sessionId: "ops-session",
    });

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT id, session_id, agent_key FROM \"session\".\"threads\" ORDER BY id",
    );

    expect(result.rows).toEqual([
      {
        id: "alice-panda-thread",
        session_id: "panda-session",
        agent_key: "panda",
      },
    ]);
  });

  it("filters readonly agent skills by agent key", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore} = await createRuntimeStores(pool);
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.setAgentSkill("panda", "calendar", "Panda calendar skill.", "# Panda");
    await agentStore.setAgentSkill("ops", "calendar", "Ops calendar skill.", "# Ops");

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT skill_key, description, content_bytes FROM \"session\".\"agent_skills\" ORDER BY skill_key",
    );

    expect(result.rows).toEqual([
      {
        skill_key: "calendar",
        description: "Panda calendar skill.",
        content_bytes: 7,
      },
    ]);
  });

  it("filters readonly agent prompts by agent key", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore} = await createRuntimeStores(pool);
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.setAgentPrompt("panda", "heartbeat", "Panda heartbeat prompt.");
    await agentStore.setAgentPrompt("ops", "heartbeat", "Ops heartbeat prompt.");

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT slug, content_bytes FROM \"session\".\"agent_prompts\" WHERE slug = 'heartbeat'",
    );

    expect(result.rows).toEqual([
      {
        slug: "heartbeat",
        content_bytes: 23,
      },
    ]);
  });

  it("filters readonly agent documents by agent key and exposes identity metadata", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore, identityStore} = await createRuntimeStores(pool);
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.setAgentDocument("panda", "memory", "Global Panda memory.");
    await agentStore.setAgentDocument("panda", "memory", "Alice Panda memory.", alice.id);
    await agentStore.setAgentDocument("ops", "memory", "Ops memory.");

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT identity_handle, scope, content_bytes FROM \"session\".\"agent_documents\" ORDER BY scope, identity_handle NULLS FIRST",
    );

    expect(result.rows).toEqual([
      {
        identity_handle: null,
        scope: "global",
        content_bytes: 20,
      },
      {
        identity_handle: "alice",
        scope: "identity",
        content_bytes: 19,
      },
    ]);
  });

  it("filters readonly agent diary by agent key and exposes identity metadata", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore, identityStore} = await createRuntimeStores(pool);
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.setDiaryEntry("panda", "2026-04-16", "Global Panda diary.");
    await agentStore.setDiaryEntry("panda", "2026-04-15", "Alice Panda diary.", alice.id);
    await agentStore.setDiaryEntry("ops", "2026-04-16", "Ops diary.");

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT entry_date, identity_handle, scope, content_bytes FROM \"session\".\"agent_diary\" ORDER BY entry_date DESC, scope",
    );

    expect(result.rows).toEqual([
      {
        entry_date: new Date("2026-04-16T00:00:00.000Z"),
        identity_handle: null,
        scope: "global",
        content_bytes: 19,
      },
      {
        entry_date: new Date("2026-04-15T00:00:00.000Z"),
        identity_handle: "alice",
        scope: "identity",
        content_bytes: 18,
      },
    ]);
  });

  it("filters readonly agent pairings by agent key", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const {agentStore, identityStore} = await createRuntimeStores(pool);
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresWatchStore({ pool }).ensureSchema();
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    const bob = await identityStore.createIdentity({
      id: "bob-id",
      handle: "bob",
      displayName: "Bob",
    });
    await agentStore.bootstrapAgent({
      agentKey: "ops",
      displayName: "Ops",
      prompts: DEFAULT_AGENT_DOCUMENT_TEMPLATES,
    });
    await agentStore.ensurePairing("panda", alice.id);
    await agentStore.ensurePairing("ops", bob.id);

    setScope({
      sessionId: "panda-session",
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlySessionQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT identity_handle FROM \"session\".\"agent_pairings\" ORDER BY identity_handle",
    );

    expect(result.rows).toEqual([
      {
        identity_handle: "alice",
      },
    ]);
  });
});
