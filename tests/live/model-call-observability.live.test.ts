import {randomUUID} from "node:crypto";

import type {AssistantMessage} from "@earendil-works/pi-ai";
import {Pool, type PoolClient} from "pg";
import {describe, expect, it} from "vitest";

import {PostgresModelCallTraceStore} from "../../src/domain/model-call-traces/postgres.js";
import {ensurePostgresModelCallTraceSchema} from "../../src/domain/model-call-traces/postgres-schema.js";
import {BufferedModelCallRecorder} from "../../src/domain/model-call-traces/recorder.js";
import type {LlmModelCallObservation} from "../../src/kernel/agent/runtime.js";
import type {PgPoolLike, PgQueryResult, PgQueryable} from "../../src/lib/postgres-query.js";
import {quoteIdentifier} from "../../src/lib/postgres-relations.js";

function scopeSql(sql: string, schema: string): string {
  return sql
    .replaceAll('"runtime".', `${quoteIdentifier(schema)}.`)
    .replaceAll('CREATE SCHEMA IF NOT EXISTS "runtime";', `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)};`);
}

class SchemaScopedClient implements PgQueryable {
  constructor(
    private readonly client: PoolClient,
    private readonly schema: string,
  ) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    const result = await this.client.query(scopeSql(sql, this.schema), [...params]);
    return {rows: result.rows, rowCount: result.rowCount};
  }

  release(): void {
    this.client.release();
  }
}

class SchemaScopedPool implements PgPoolLike {
  constructor(
    private readonly pool: Pool,
    private readonly schema: string,
  ) {}

  async query(sql: string, params: readonly unknown[] = []): Promise<PgQueryResult> {
    const result = await this.pool.query(scopeSql(sql, this.schema), [...params]);
    return {rows: result.rows, rowCount: result.rowCount};
  }

  async connect(): Promise<SchemaScopedClient> {
    return new SchemaScopedClient(await this.pool.connect(), this.schema);
  }
}

function assistant(timestamp: number): AssistantMessage {
  return {
    role: "assistant",
    content: [{type: "text", text: "done"}],
    api: "openai-responses",
    model: "openai/gpt-live",
    usage: {
      input: 11,
      output: 7,
      cacheRead: 3,
      cacheWrite: 2,
      totalTokens: 23,
      cost: {input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.002, total: 0.033},
    },
    stopReason: "stop",
    timestamp,
  };
}

function observation(input: {
  attempt: number;
  startedAt: number;
  error?: Error;
}): LlmModelCallObservation {
  return {
    mode: "complete",
    attempt: input.attempt,
    startedAt: input.startedAt,
    finishedAt: input.startedAt + 50,
    tools: [],
    request: {
      providerName: "openai",
      modelId: "gpt-live",
      metadata: {agentKey: "panda", sessionId: "session-live", threadId: "thread-live", turn: 1},
      context: {
        systemPrompt: "bounded system prompt",
        messages: [{role: "user", content: "hello"}],
        tools: [],
      },
    },
    ...(input.error ? {error: input.error} : {response: assistant(input.startedAt + 50)}),
  };
}

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const postgresIt = databaseUrl ? it : it.skip;

describe("model-call observability with PostgreSQL", () => {
  it("requires TEST_DATABASE_URL for the PostgreSQL contract check", () => {
    expect(databaseUrl).toMatch(/^postgres(?:ql)?:\/\//);
  });

  postgresIt("persists, reads, aggregates, and expires split telemetry", async () => {
    const pool = new Pool({
      connectionString: databaseUrl,
      application_name: "panda/test-model-call-observability",
      max: 1,
      statement_timeout: 5_000,
      query_timeout: 7_500,
    });
    const schema = `tracewright_${randomUUID().replaceAll("-", "")}`;
    const quotedSchema = quoteIdentifier(schema);
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quotedSchema}`);
      schemaCreated = true;
      await pool.query(`CREATE TABLE ${quotedSchema}.model_call_traces (id UUID PRIMARY KEY)`);
      const scopedPool = new SchemaScopedPool(pool, schema);
      const store = new PostgresModelCallTraceStore({pool: scopedPool});
      await ensurePostgresModelCallTraceSchema(scopedPool);
      const legacy = await pool.query("SELECT to_regclass($1) AS relation", [`${schema}.model_call_traces`]);
      expect(legacy.rows[0]?.relation).toBeNull();
      const indexes = await pool.query<{indexname: string}>(`
        SELECT indexname
        FROM pg_indexes
        WHERE schemaname = $1
      `, [schema]);
      expect(indexes.rows.map((row) => row.indexname)).toEqual(expect.arrayContaining([
        "runtime_model_call_attempts_started_idx",
        "runtime_model_call_attempts_run_idx",
        "runtime_model_call_attempts_session_started_idx",
        "runtime_model_call_attempts_agent_started_idx",
        "runtime_model_call_attempts_failure_idx",
        "runtime_model_call_snapshots_expires_idx",
      ]));

      const firstHour = Date.UTC(2040, 0, 1);
      const recorder = new BufferedModelCallRecorder({
        sink: store,
        successSnapshotSampleRate: 1,
        attemptRetentionDays: 90,
        snapshotRetentionDays: 7,
      });
      recorder.observeModelCall(observation({attempt: 1, startedAt: firstHour + 10 * 60_000}));
      recorder.observeModelCall(observation({attempt: 2, startedAt: firstHour + 70 * 60_000}));
      recorder.observeModelCall(observation({
        attempt: 3,
        startedAt: firstHour + 80 * 60_000,
        error: new Error("provider timeout"),
      }));
      await recorder.flush();

      const list = await store.listTraces();
      expect(list.meta.total).toBe(3);
      expect(list.data.every((attempt) => attempt.snapshot === undefined)).toBe(true);
      await expect(store.getTrace(list.data[0]!.id)).resolves.toMatchObject({
        snapshot: expect.objectContaining({bytes: expect.any(Number)}),
      });
      await expect(store.listFailureGroups()).resolves.toMatchObject([
        {count: 1, label: "Error", summary: "provider timeout"},
      ]);
      await expect(store.listUsageBuckets({
        from: firstHour,
        to: firstHour + 2 * 60 * 60_000,
        bucketMs: 60 * 60_000,
      })).resolves.toEqual([
        expect.objectContaining({startedAt: firstHour, calls: 1, totalTokens: 23}),
        expect.objectContaining({startedAt: firstHour + 60 * 60_000, calls: 2, failures: 1, totalTokens: 23}),
      ]);

      await store.purgeExpiredBatch(firstHour + 8 * 24 * 60 * 60_000, 100);
      const snapshotCount = await pool.query(`SELECT COUNT(*)::int AS count FROM ${quotedSchema}.model_call_snapshots`);
      const attemptCount = await pool.query(`SELECT COUNT(*)::int AS count FROM ${quotedSchema}.model_call_attempts`);
      expect(snapshotCount.rows[0]?.count).toBe(0);
      expect(attemptCount.rows[0]?.count).toBe(3);
    } finally {
      if (schemaCreated) await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      await pool.end();
    }
  });
});
