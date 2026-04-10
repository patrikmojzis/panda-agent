import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {
    ensureReadonlyChatQuerySchema,
    PostgresHomeThreadStore,
    PostgresScheduledTaskStore,
    PostgresThreadRuntimeStore,
} from "../src/index.js";

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

      if (/^CREATE VIEW "panda_threads"/i.test(statement)) {
        const whereMatches = [...statement.matchAll(/\bWHERE\b/gi)];
        const whereIndex = whereMatches.at(-1)?.index;
        const whereClause = whereIndex === undefined
          ? undefined
          : statement.slice(whereIndex + "WHERE".length).trim();
        if (!whereClause) {
          throw new Error("Expected panda_threads view SQL to contain a WHERE clause.");
        }

        await this.pool.query(`
          CREATE VIEW "panda_threads" AS
          SELECT
            t.id,
            t.identity_id,
            t.agent_key
          FROM "thread_runtime_threads" AS t
          WHERE ${whereClause}
        `);
        continue;
      }

      if (/^CREATE VIEW "panda_(messages_raw|messages|tool_results|inputs|runs)"/i.test(statement)) {
        continue;
      }

      if (/^CREATE VIEW "panda_scheduled_tasks"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "panda_scheduled_tasks" AS
          SELECT
            scheduled_tasks.id,
            scheduled_tasks.identity_id,
            scheduled_tasks.agent_key,
            CASE
              WHEN scheduled_tasks.target_kind = 'thread' THEN scheduled_tasks.target_thread_id
              ELSE home_threads.thread_id
            END AS resolved_thread_id
          FROM "thread_runtime_scheduled_tasks" AS scheduled_tasks
          LEFT JOIN "thread_runtime_home_threads" AS home_threads
            ON home_threads.identity_id = scheduled_tasks.identity_id
          WHERE scheduled_tasks.identity_id = current_setting('panda.identity_id', true)
            AND scheduled_tasks.agent_key = current_setting('panda.agent_key', true)
        `);
        continue;
      }

      if (/^CREATE VIEW "panda_scheduled_task_runs"/i.test(statement)) {
        await this.pool.query(`
          CREATE VIEW "panda_scheduled_task_runs" AS
          SELECT
            scheduled_task_runs.id,
            scheduled_task_runs.task_id,
            scheduled_task_runs.identity_id,
            scheduled_task_runs.agent_key
          FROM "thread_runtime_scheduled_task_runs" AS scheduled_task_runs
          WHERE scheduled_task_runs.identity_id = current_setting('panda.identity_id', true)
            AND scheduled_task_runs.agent_key = current_setting('panda.agent_key', true)
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
    setScope(next: { identityId?: string | null; agentKey?: string | null }) {
      scope.set("panda.identity_id", next.identityId ?? null);
      scope.set("panda.agent_key", next.agentKey ?? null);
    },
  };
}

describe("ensureReadonlyChatQuerySchema", () => {
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

  it("creates split chat views and grants access to them", async () => {
    const queryable = new RecordingQueryable();

    const views = await ensureReadonlyChatQuerySchema({
      queryable,
      readonlyRole: "readonly_user",
    });

    expect(views).toEqual({
      threads: "\"panda_threads\"",
      messages: "\"panda_messages\"",
      messagesRaw: "\"panda_messages_raw\"",
      toolResults: "\"panda_tool_results\"",
      inputs: "\"panda_inputs\"",
      runs: "\"panda_runs\"",
      scheduledTasks: "\"panda_scheduled_tasks\"",
      scheduledTaskRuns: "\"panda_scheduled_task_runs\"",
    });

    expect(queryable.queries).toHaveLength(2);
    expect(queryable.queries[0]).toContain("CREATE VIEW \"panda_messages_raw\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"panda_messages\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"panda_tool_results\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"panda_scheduled_tasks\"");
    expect(queryable.queries[0]).toContain("CREATE VIEW \"panda_scheduled_task_runs\"");
    expect(queryable.queries[0]).toContain("FROM \"panda_messages_raw\" AS raw");
    expect(queryable.queries[0]).toContain("WHERE raw.role IN ('user', 'assistant')");
    expect(queryable.queries[0]).toContain("t.inference_projection");
    expect(queryable.queries[0]).toContain("t.identity_id = current_setting('panda.identity_id', true)");
    expect(queryable.queries[0]).toContain("t.agent_key = current_setting('panda.agent_key', true)");
    expect(queryable.queries[1]).toContain("GRANT SELECT ON \"panda_threads\", \"panda_messages\", \"panda_messages_raw\", \"panda_tool_results\", \"panda_inputs\", \"panda_runs\", \"panda_scheduled_tasks\", \"panda_scheduled_task_runs\"");
  });

  it("filters readonly threads by identity when multiple identities share an agent key", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const store = new PostgresThreadRuntimeStore({ pool });
    await store.ensureSchema();
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresHomeThreadStore({ pool }).ensureSchema();

    const alice = await store.identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    const bob = await store.identityStore.createIdentity({
      id: "bob-id",
      handle: "bob",
      displayName: "Bob",
    });

    await store.createThread({
      id: "alice-thread",
      identityId: alice.id,
      agentKey: "panda",
    });
    await store.createThread({
      id: "bob-thread",
      identityId: bob.id,
      agentKey: "panda",
    });

    setScope({
      identityId: alice.id,
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlyChatQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT id, identity_id, agent_key FROM \"panda_threads\" ORDER BY id",
    );

    expect(result.rows).toEqual([
      {
        id: "alice-thread",
        identity_id: "alice-id",
        agent_key: "panda",
      },
    ]);
  });

  it("filters readonly threads by agent when one identity has multiple agents", async () => {
    const { pool, setScope } = createScopedPool();
    pools.push(pool);

    const store = new PostgresThreadRuntimeStore({ pool });
    await store.ensureSchema();
    await new PostgresScheduledTaskStore({ pool }).ensureSchema();
    await new PostgresHomeThreadStore({ pool }).ensureSchema();

    const alice = await store.identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });

    await store.createThread({
      id: "alice-panda-thread",
      identityId: alice.id,
      agentKey: "panda",
    });
    await store.createThread({
      id: "alice-ops-thread",
      identityId: alice.id,
      agentKey: "ops",
    });

    setScope({
      identityId: alice.id,
      agentKey: "panda",
    });
    const queryable = new PgMemReadonlySchemaQueryable(pool);
    await ensureReadonlyChatQuerySchema({ queryable });

    const result = await pool.query(
      "SELECT id, identity_id, agent_key FROM \"panda_threads\" ORDER BY id",
    );

    expect(result.rows).toEqual([
      {
        id: "alice-panda-thread",
        identity_id: "alice-id",
        agent_key: "panda",
      },
    ]);
  });
});
