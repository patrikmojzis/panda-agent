import {describe, expect, it} from "vitest";

import {
  createPostgresReadonlyQueryCommand,
  postgresReadonlyQueryCommandDescriptor,
  POSTGRES_READONLY_QUERY_COMMAND_NAME,
} from "../src/integrations/postgres/readonly-query-command.js";
import {ToolError} from "../src/kernel/agent/exceptions.js";
import {readDatabaseUsername} from "../src/domain/threads/runtime/index.js";
import {READONLY_SESSION_VIEW_BASENAMES} from "../src/domain/threads/runtime/postgres-readonly.js";

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

class FakeReadonlyClient {
  readonly queries: RecordedQuery[] = [];

  constructor(
    private readonly rows: readonly unknown[] = [],
    private readonly failingSql?: string,
  ) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({text, values});

    if (this.failingSql && text.includes(this.failingSql)) {
      throw new Error("boom");
    }

    if (text.startsWith("SELECT set_config(")) {
      return {rows: [{set_config: values?.[0] ?? null}]};
    }

    if (/^(BEGIN READ ONLY|SET LOCAL|COMMIT|ROLLBACK)$/m.test(text) || text.startsWith("SET LOCAL")) {
      return {rows: []};
    }

    return {rows: this.rows};
  }

  release(): void {}
}

class FakeReadonlyPool {
  readonly client: FakeReadonlyClient;
  connectCalls = 0;

  constructor(rows: readonly unknown[] = [], failingSql?: string) {
    this.client = new FakeReadonlyClient(rows, failingSql);
  }

  async connect(): Promise<FakeReadonlyClient> {
    this.connectCalls += 1;
    return this.client;
  }
}

function createCommand(pool: FakeReadonlyPool, options: {
  maxRows?: number;
} = {}) {
  return createPostgresReadonlyQueryCommand({
    pool,
    ...options,
  });
}

function request(sql: string, skillPolicy = {mode: "all_agent" as const}) {
  return {
    command: POSTGRES_READONLY_QUERY_COMMAND_NAME,
    input: {sql},
    scope: {
      agentKey: "panda",
      sessionId: "session-main",
      skillPolicy,
    },
  };
}

function inputRequest(input: Record<string, unknown>) {
  return {
    command: POSTGRES_READONLY_QUERY_COMMAND_NAME,
    input,
    scope: {
      agentKey: "panda",
      sessionId: "session-main",
      skillPolicy: {mode: "all_agent" as const},
    },
  };
}

function readonlySchemaRows(excludedView?: string): Array<Record<string, unknown>> {
  return READONLY_SESSION_VIEW_BASENAMES
    .filter((view) => view !== excludedView)
    .flatMap((view) => {
      const columns = view === "messages"
        ? [
            ["id", "uuid"],
            ["thread_id", "uuid"],
            ["role", "text"],
            ["text", "text"],
            ["created_at", "timestamp with time zone"],
          ]
        : [["id", "uuid"]];
      return columns.map(([columnName, dataType], index) => ({
        table_name: view,
        column_name: columnName,
        data_type: dataType,
        ordinal_position: index + 1,
      }));
    });
}

describe("postgres readonly query command", () => {
  it("exposes descriptor-backed guidance for scoped readonly views", () => {
    expect(postgresReadonlyQueryCommandDescriptor.usage).toBe("panda postgres readonly query (--sql <text|@file|@-> [--max-rows <n>]|--schema-help)");
    expect(postgresReadonlyQueryCommandDescriptor.inputModes).toEqual(["flags", "json", "stdin", "file"]);
    expect(postgresReadonlyQueryCommandDescriptor.arguments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "sql",
        description: "Single read-only SELECT or WITH query. Required unless --schema-help is used. Use @file or @- for multiline SQL.",
        valueType: "string",
        valueName: "text|@file|@-",
      }),
      expect.objectContaining({
        name: "max-rows",
        valueName: "n",
      }),
      expect.objectContaining({
        name: "schema-help",
        valueType: "boolean",
      }),
      expect.objectContaining({
        name: "json",
        valueType: "json",
      }),
    ]));
    expect(postgresReadonlyQueryCommandDescriptor.description).toContain("session.agent_sessions exposes current_thread_id, not thread_id.");
    expect(postgresReadonlyQueryCommandDescriptor.description).toContain("session.prompts to the current session");
    expect(postgresReadonlyQueryCommandDescriptor.description).toContain("session.agent_pairings and session.agent_skills to the current agent");
    expect(postgresReadonlyQueryCommandDescriptor.description).toContain("left(...), substring(...), regex filters, full-text search");
    expect(postgresReadonlyQueryCommandDescriptor.description).toContain("Do not invent is_active flags or extra session_id subqueries");
    expect(postgresReadonlyQueryCommandDescriptor.description).toContain("query session.todos");
    expect(postgresReadonlyQueryCommandDescriptor.description).toContain("query session.subagent_history");
    expect(postgresReadonlyQueryCommandDescriptor.description).toContain("query session.scheduled_tasks or session.watches directly");
    expect(postgresReadonlyQueryCommandDescriptor.description).not.toContain("agent_telepathy_devices");
  });

  it("runs queries inside a read-only transaction and scopes them by session and agent", async () => {
    const pool = new FakeReadonlyPool([{
      thread_id: "thread-1",
      created_at: new Date("2026-04-08T09:00:00.000Z"),
      message: {
        role: "toolResult",
        content: [{
          type: "image",
          data: "A".repeat(200),
          mimeType: "image/png",
        }],
      },
      long_text: "x".repeat(5_000),
    }]);
    const command = createCommand(pool);

    const result = await command.execute(request("select * from session.messages order by created_at desc limit 5"));
    const rows = result.output.rows as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_at).toBe("2026-04-08T09:00:00.000Z");
    expect(JSON.stringify(rows[0])).toContain("[omitted image data:");
    expect(String(rows[0]?.long_text)).toContain("...");
    expect(result.output.sql).toBeUndefined();
    expect(result.output.views).toBeUndefined();
    expect(result.output.operation).toBe("query");
    expect(result.output.maxRows).toBe(50);
    expect(result.output.truncated).toBe(true);
    expect(result.output.truncationReasons).toEqual(["cell_cap"]);

    expect(pool.client.queries.map((query) => query.text)).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '500ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
      "SELECT set_config('runtime.session_id', $1, true)",
      "SELECT set_config('runtime.agent_key', $1, true)",
      "SELECT set_config('runtime.skill_policy', $1, true)",
      "SELECT set_config('runtime.skill_allowlist', $1, true)",
      "SELECT * FROM (select * from session.messages order by created_at desc limit 5) AS runtime_readonly_query LIMIT 51",
      "COMMIT",
    ]);
    expect(pool.client.queries[4]?.values).toEqual(["session-main"]);
    expect(pool.client.queries[5]?.values).toEqual(["panda"]);
    expect(pool.client.queries[6]?.values).toEqual(["all_agent"]);
    expect(pool.client.queries[7]?.values).toEqual([""]);
  });

  it("rejects non-read-only SQL and multiple statements", async () => {
    const command = createCommand(new FakeReadonlyPool());

    await expect(command.execute(request("delete from session.threads"))).rejects.toBeInstanceOf(ToolError);
    await expect(command.execute(request("select 1; select 2"))).rejects.toBeInstanceOf(ToolError);
  });

  it("truncates rows beyond the configured cap", async () => {
    const pool = new FakeReadonlyPool([{id: 1}, {id: 2}, {id: 3}]);
    const command = createCommand(pool, {maxRows: 2});

    const result = await command.execute(request("select * from session.threads order by updated_at desc limit 10"));
    const rows = result.output.rows as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    expect(result.output.truncated).toBe(true);
    expect(result.output.truncationReasons).toEqual(["row_cap"]);
    expect(result.output.rowCount).toBe(2);
  });

  it("uses per-query maxRows without raising the configured cap", async () => {
    const pool = new FakeReadonlyPool([{id: 1}, {id: 2}, {id: 3}]);
    const command = createCommand(pool, {maxRows: 3});

    const result = await command.execute(inputRequest({
      sql: "select * from session.threads order by updated_at desc limit 10",
      maxRows: 1,
    }));

    expect(result.output).toMatchObject({
      operation: "query",
      maxRows: 1,
      rowCount: 1,
      truncated: true,
      truncationReasons: ["row_cap"],
      rows: [{id: 1}],
    });
    expect(pool.client.queries.map((query) => query.text)).toContain(
      "SELECT * FROM (select * from session.threads order by updated_at desc limit 10) AS runtime_readonly_query LIMIT 2",
    );
    await expect(command.execute(inputRequest({
      sql: "select * from session.threads",
      maxRows: 4,
    }))).rejects.toThrow("postgres.readonly.query maxRows must be between 1 and 3.");
  });

  it("returns live schema help for every canonical readonly view", async () => {
    const pool = new FakeReadonlyPool(readonlySchemaRows());
    const command = createCommand(pool);

    const result = await command.execute(inputRequest({schemaHelp: true}));

    expect(pool.connectCalls).toBe(1);
    expect(result.output).toMatchObject({
      operation: "schema_help",
      views: expect.arrayContaining([
        expect.objectContaining({
          name: "session.messages",
          columns: expect.arrayContaining([
            {name: "text", type: "text"},
          ]),
        }),
        expect.objectContaining({name: "session.runtime_config"}),
        expect.objectContaining({name: "session.watch_runs"}),
        expect.objectContaining({name: "session.email_messages"}),
      ]),
      examples: expect.arrayContaining([
        expect.objectContaining({
          sql: expect.stringContaining("information_schema.columns"),
        }),
        expect.objectContaining({
          sql: expect.stringContaining("left(text, 500)"),
        }),
      ]),
    });
    expect((result.output.views as Array<{name: string}>).map((view) => view.name)).toEqual(
      READONLY_SESSION_VIEW_BASENAMES.map((name) => `session.${name}`),
    );
    expect(JSON.stringify(result.output)).not.toContain("runtime.");
    expect(pool.client.queries.map((query) => query.text.trim())).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL statement_timeout = '5000ms'",
      expect.stringContaining("FROM information_schema.columns"),
      "COMMIT",
    ]);
    expect(pool.client.queries[2]?.values).toEqual([READONLY_SESSION_VIEW_BASENAMES]);
    await expect(command.execute(inputRequest({
      schemaHelp: true,
      sql: "select 1",
    }))).rejects.toThrow("schemaHelp cannot be combined");
  });

  it("fails closed when a canonical readonly view is missing", async () => {
    const pool = new FakeReadonlyPool(readonlySchemaRows("messages"));
    const command = createCommand(pool);

    await expect(command.execute(inputRequest({schemaHelp: true}))).rejects.toThrow(
      "Readonly schema is incomplete: expected session.messages but it is unavailable.",
    );
    expect(pool.client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("replaces oversized object values with placeholders", async () => {
    const pool = new FakeReadonlyPool([{
      message: {
        nested: {
          large: "x".repeat(10_000),
        },
      },
    }]);
    const command = createCommand(pool);

    const result = await command.execute(request("select * from session.messages_raw limit 1"));
    const rows = result.output.rows as Array<Record<string, unknown>>;

    expect(String(rows[0]?.message)).toMatch(/^<jsonb \d+B omitted; query specific fields>$/);
    expect(result.output.truncationReasons).toEqual(["cell_cap"]);
  });

  it("rolls back and surfaces database errors", async () => {
    const sql = "select * from session.messages";
    const pool = new FakeReadonlyPool([], sql);
    const command = createCommand(pool);

    await expect(command.execute(request(sql))).rejects.toBeInstanceOf(ToolError);

    expect(pool.client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("rejects malformed Postgres rows before building output", async () => {
    const command = createCommand(new FakeReadonlyPool([null]));

    await expect(command.execute(request("select * from session.messages limit 1")))
      .rejects.toThrow("Postgres returned a non-object row.");
  });

  it("reads usernames from postgres urls when present", () => {
    expect(readDatabaseUsername("postgresql://readonly@example.com/panda")).toBe("readonly");
    expect(readDatabaseUsername("postgresql://localhost/panda?user=readonly_user")).toBe("readonly_user");
    expect(readDatabaseUsername("postgresql://localhost/panda?username=readonly_name")).toBe("readonly_name");
    expect(readDatabaseUsername("postgresql:///panda_dev")).toBeNull();
  });

  it("sets readonly skill policy GUCs from command scope", async () => {
    const pool = new FakeReadonlyPool([]);
    const command = createCommand(pool);

    await command.execute(request(
      "select * from session.agent_skills order by skill_key limit 5",
      {mode: "allowlist", skillKeys: ["calendar", "finance"]},
    ));

    expect(pool.client.queries[6]?.values).toEqual(["allowlist"]);
    expect(pool.client.queries[7]?.values).toEqual(["calendar,finance"]);
  });

  it("blocks Postgres dynamic SQL and dump functions before connecting", async () => {
    const pool = new FakeReadonlyPool([{id: "message-1"}]);
    const command = createCommand(pool);
    const blockedSql = [
      "select query_to_xml('select * from runtime.' || 'model_call_' || 'traces', true, true, '')",
      "select '--' || query_to_xml('select * from runtime.' || 'model_call_' || 'traces', true, true, '')",
      "select query_to_xml /* bypass */ ('select * from runtime.' || 'model_call_' || 'traces', true, true, '')",
      `select U&"query_to\\005Fxml"('select * from session.messages', true, true, '')`,
      `select pg_catalog.U&"table_to\\005Fxml"(to_regclass('session.messages'), true, true, '')`,
      `select U&"query_to!005Fxml" UESCAPE '!'('select * from session.messages', true, true, '')`,
      "select pg_catalog.table_to_xml(to_regclass('runtime.' || 'model_call_' || 'traces'), true, true, '')",
      "select schema_to_xml('runtime', true, true, '')",
      "select database_to_xml(true, true, '')",
      "select cursor_to_xml('trace_cursor'::refcursor, 100, true, true, '')",
      "select query_to_xmlschema('select * from session.messages', true, true, '')",
      `select "table_to_xmlschema"(to_regclass('runtime.' || 'model_call_' || 'traces'), true, true, '')`,
      "select schema_to_xmlschema('runtime', true, true, '')",
      "select database_to_xmlschema(true, true, '')",
      "select query_to_xml_and_xmlschema('select * from session.messages', true, true, '')",
      "select * from dblink('dbname=panda', 'select * from runtime.' || 'model_call_' || 'traces') as t(id text)",
      "select dblink_connect('dbname=panda')",
      "select lo_export(123, '/tmp/model-call-traces.dump')",
      "select lo_import('/tmp/model-call-traces.dump')",
    ];

    for (const sql of blockedSql) {
      await expect(command.execute(request(sql))).rejects.toThrow("Readonly SQL cannot use Postgres dynamic SQL, dump, dblink, or file export functions.");
    }
    expect(pool.connectCalls).toBe(0);
  });

  it("blocks direct model call trace table reads while allowing session views", async () => {
    const pool = new FakeReadonlyPool([{id: "message-1"}]);
    const command = createCommand(pool);
    const blockedSql = [
      "select * from runtime.model_call_traces limit 1",
      "select '--' as marker, id from runtime.model_call_traces limit 1",
      "select $tag$--$tag$ as marker, id from runtime.model_call_traces limit 1",
      "select * from model_call_traces limit 1",
      'select * from "runtime"."model_call_traces" limit 1',
      'select * from runtime.U&"model_call\\005Ftraces" limit 1',
      'select * from U&"model_call\\005Ftraces" limit 1',
      "select * from runtime /* bypass */ . /* bypass */ model_call_traces limit 1",
      "with traces as (select * from runtime.model_call_traces) select * from traces",
      'select * from (select * from "model_call_traces") traces',
      'with "model_call_traces" as (select 1) select * from "model_call_traces"',
    ];

    for (const sql of blockedSql) {
      await expect(command.execute(request(sql))).rejects.toThrow("Model call traces are not exposed through readonly SQL.");
    }
    expect(pool.connectCalls).toBe(0);

    const result = await command.execute(request("select '--' as marker, id from session.messages order by created_at desc limit 1"));

    expect(result.output.rows).toEqual([{id: "message-1"}]);
    expect(pool.connectCalls).toBe(1);
    expect(pool.client.queries.some((query) => query.text.includes("session.messages"))).toBe(true);
  });

  it("blocks readonly SQL from mutating runtime scope", async () => {
    const command = createCommand(new FakeReadonlyPool([]));

    await expect(command.execute(request(
      "with x as (select set_config('runtime.skill_policy', 'all_agent', true)) select * from session.agent_skills",
    ))).rejects.toThrow("Readonly SQL cannot mutate runtime scope.");
  });
});
