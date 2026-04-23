import {describe, expect, it} from "vitest";

import {
    Agent,
    type DefaultAgentSessionContext,
    PostgresReadonlyQueryTool,
    RunContext,
    ToolError,
    type ToolResultPayload,
} from "../src/index.js";
import {readDatabaseUsername} from "../src/domain/threads/runtime/index.js";

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

class FakeReadonlyClient {
  readonly queries: RecordedQuery[] = [];

  constructor(
    private readonly rows: readonly Record<string, unknown>[] = [],
    private readonly failingSql?: string,
  ) {}

  async query(text: string, values?: readonly unknown[]) {
    this.queries.push({ text, values });

    if (this.failingSql && text.includes(this.failingSql)) {
      throw new Error("boom");
    }

    if (text.startsWith("SELECT set_config(")) {
      return { rows: [{ set_config: values?.[0] ?? null }] };
    }

    if (/^(BEGIN READ ONLY|SET LOCAL|COMMIT|ROLLBACK)$/m.test(text) || text.startsWith("SET LOCAL")) {
      return { rows: [] };
    }

    return { rows: this.rows };
  }

  release(): void {}
}

class FakeReadonlyPool {
  readonly client: FakeReadonlyClient;
  connectCalls = 0;

  constructor(rows: readonly Record<string, unknown>[] = [], failingSql?: string) {
    this.client = new FakeReadonlyClient(rows, failingSql);
  }

  async connect(): Promise<FakeReadonlyClient> {
    this.connectCalls += 1;
    return this.client;
  }
}

function createRunContext(context: DefaultAgentSessionContext): RunContext<DefaultAgentSessionContext> {
  return new RunContext({
    agent: new Agent({
      name: "readonly-test-agent",
      instructions: "Use tools.",
    }),
    turn: 1,
    maxTurns: 5,
    messages: [],
    context,
  });
}

function parseToolResult(result: ToolResultPayload): Record<string, unknown> {
  const textPart = result.content.find((part) => part.type === "text");
  if (!textPart) {
    throw new Error("Expected text output.");
  }

  return JSON.parse(textPart.text) as Record<string, unknown>;
}

describe("PostgresReadonlyQueryTool", () => {
  it("exports a simple object schema with a single sql field", () => {
    const tool = new PostgresReadonlyQueryTool({
      pool: new FakeReadonlyPool(),
    });

    expect(tool.piTool.parameters).toMatchObject({
      type: "object",
      properties: {
        sql: {
          type: "string",
        },
      },
      required: ["sql"],
    });
  });

  it("teaches session-scoped readonly view usage", () => {
    const tool = new PostgresReadonlyQueryTool({
      pool: new FakeReadonlyPool(),
    });

    expect(tool.description).toContain("session.agent_sessions exposes current_thread_id, not thread_id.");
    expect(tool.description).toContain("session.agent_prompts, session.agent_pairings, session.agent_skills, and session.agent_telepathy_devices");
    expect(tool.description).toContain("left(...), substring(...), regex filters, full-text search");
    expect(tool.description).toContain("Do not invent is_active flags or extra session_id subqueries");
    expect(tool.description).toContain("query session.scheduled_tasks or session.watches directly");
    expect(tool.description).toContain("session.agent_telepathy_devices for registered Mac receivers");
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
    const tool = new PostgresReadonlyQueryTool({
      pool,
    });

    const result = await tool.run(
      { sql: "select * from session.messages order by created_at desc limit 5" },
      createRunContext({
        sessionId: "session-main",
        identityId: "identity-alice",
        threadId: "thread-1",
        agentKey: "panda",
      }),
    ) as ToolResultPayload;

    const parsed = parseToolResult(result);
    const rows = parsed.rows as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.created_at).toBe("2026-04-08T09:00:00.000Z");
    expect(JSON.stringify(rows[0])).toContain("[omitted image data:");
    expect(String(rows[0]?.long_text)).toContain("...");
    expect(parsed.sql).toBeUndefined();
    expect(parsed.views).toBeUndefined();
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncationReasons).toEqual(["cell_cap"]);

    expect(pool.client.queries.map((query) => query.text)).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL lock_timeout = '500ms'",
      "SET LOCAL idle_in_transaction_session_timeout = '5000ms'",
      "SELECT set_config('runtime.session_id', $1, true)",
      "SELECT set_config('runtime.agent_key', $1, true)",
      "SELECT * FROM (select * from session.messages order by created_at desc limit 5) AS runtime_readonly_query LIMIT 51",
      "COMMIT",
    ]);
    expect(pool.client.queries[4]?.values).toEqual(["session-main"]);
    expect(pool.client.queries[5]?.values).toEqual(["panda"]);
  });

  it("rejects non-read-only SQL and multiple statements", async () => {
    const tool = new PostgresReadonlyQueryTool({
      pool: new FakeReadonlyPool(),
    });
    const context = createRunContext({
      sessionId: "session-main",
      identityId: "identity-alice",
      threadId: "thread-1",
      agentKey: "panda",
    });

    await expect(tool.run(
      { sql: "delete from session.threads" },
      context,
    )).rejects.toBeInstanceOf(ToolError);

    await expect(tool.run(
      { sql: "select 1; select 2" },
      context,
    )).rejects.toBeInstanceOf(ToolError);
  });

  it("truncates rows beyond the configured cap", async () => {
    const pool = new FakeReadonlyPool([
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    const tool = new PostgresReadonlyQueryTool({
      pool,
      maxRows: 2,
    });

    const result = await tool.run(
      { sql: "select * from session.threads order by updated_at desc limit 10" },
      createRunContext({
        sessionId: "session-main",
        identityId: "identity-alice",
        threadId: "thread-1",
        agentKey: "panda",
      }),
    ) as ToolResultPayload;

    const parsed = parseToolResult(result);
    const rows = parsed.rows as Array<Record<string, unknown>>;

    expect(rows).toHaveLength(2);
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncationReasons).toEqual(["row_cap"]);
    expect(parsed.rowCount).toBe(2);
  });

  it("replaces oversized object values with placeholders", async () => {
    const pool = new FakeReadonlyPool([{
      message: {
        nested: {
          large: "x".repeat(10_000),
        },
      },
    }]);
    const tool = new PostgresReadonlyQueryTool({
      pool,
    });

    const result = await tool.run(
      { sql: "select * from session.messages_raw limit 1" },
      createRunContext({
        sessionId: "session-main",
        identityId: "identity-alice",
        threadId: "thread-1",
        agentKey: "panda",
      }),
    ) as ToolResultPayload;

    const parsed = parseToolResult(result);
    const rows = parsed.rows as Array<Record<string, unknown>>;

    expect(String(rows[0]?.message)).toMatch(/^<jsonb \d+B omitted; query specific fields>$/);
    expect(parsed.truncationReasons).toEqual(["cell_cap"]);
  });

  it("rolls back and surfaces database errors", async () => {
    const sql = "select * from session.messages";
    const pool = new FakeReadonlyPool([], sql);
    const tool = new PostgresReadonlyQueryTool({
      pool,
    });

    await expect(tool.run(
      { sql },
      createRunContext({
        sessionId: "session-main",
        identityId: "identity-alice",
        threadId: "thread-1",
        agentKey: "panda",
      }),
    )).rejects.toBeInstanceOf(ToolError);

    expect(pool.client.queries.at(-1)?.text).toBe("ROLLBACK");
  });

  it("fails fast when sessionId is missing from the session context", async () => {
    const pool = new FakeReadonlyPool();
    const tool = new PostgresReadonlyQueryTool({
      pool,
    });

    await expect(tool.run(
      { sql: "select * from session.threads limit 1" },
      createRunContext({
        threadId: "thread-1",
        agentKey: "panda",
      }),
    )).rejects.toThrow(
      "The readonly Postgres tool requires both sessionId and agentKey in the runtime session context.",
    );

    expect(pool.connectCalls).toBe(0);
    expect(pool.client.queries).toEqual([]);
  });

  it("reads usernames from postgres urls when present", () => {
    expect(readDatabaseUsername("postgresql://readonly@example.com/panda")).toBe("readonly");
    expect(readDatabaseUsername("postgresql://localhost/panda?user=readonly_user")).toBe("readonly_user");
    expect(readDatabaseUsername("postgresql://localhost/panda?username=readonly_name")).toBe("readonly_name");
    expect(readDatabaseUsername("postgresql:///panda_dev")).toBeNull();
  });

  it("supports exploratory reads against agent metadata views", async () => {
    const pool = new FakeReadonlyPool([{
      slug: "heartbeat",
      preview: "Keep it short.",
    }]);
    const tool = new PostgresReadonlyQueryTool({
      pool,
    });

    const result = await tool.run(
      { sql: "select slug, left(content, 16) as preview from session.agent_prompts order by updated_at desc limit 5" },
      createRunContext({
        sessionId: "session-main",
        identityId: "identity-alice",
        threadId: "thread-1",
        agentKey: "panda",
      }),
    ) as ToolResultPayload;

    const parsed = parseToolResult(result);
    expect(parsed.rows).toEqual([{
      slug: "heartbeat",
      preview: "Keep it short.",
    }]);
    expect(pool.client.queries[6]?.text).toContain("left(content, 16) as preview from session.agent_prompts");
  });
});
