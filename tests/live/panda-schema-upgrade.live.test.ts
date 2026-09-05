import {createHash, randomUUID} from "node:crypto";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {buildThreadRuntimeTableNames} from "../../src/domain/threads/runtime/postgres-shared.js";
import {createPostgresMigrator} from "../../src/lib/postgres-migrations.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

describe("Panda schema hard-cut upgrade", () => {
  let pool: ReturnType<typeof createPostgresPool>;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/schema-upgrade-live-test",
      max: 4,
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  liveIt("backfills run cutoffs, repairs wake state, and bounds request receipts", async () => {
    const migrator = (count: number) => createPostgresMigrator({
      pool,
      migrations: PANDA_SCHEMA_MIGRATIONS.slice(0, count),
      schemaName: "runtime",
      tableName: "schema_migrations",
      lockName: "panda:schema-upgrade-live-test",
    });
    await migrator(4).migrate();

    const agents = new PostgresAgentStore({pool});
    const sessions = new PostgresSessionStore({pool});
    const threads = new PostgresThreadRuntimeStore({pool});
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await sessions.createSession({
      id: "upgrade-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "upgrade-thread",
    });
    await threads.createThread({id: "upgrade-thread", sessionId: "upgrade-session"});
    await sessions.createSession({
      id: "stale-inter-agent-session",
      agentKey: "panda",
      kind: "subagent",
      currentThreadId: "stale-inter-agent-thread",
    });
    await threads.createThread({
      id: "stale-inter-agent-thread",
      sessionId: "stale-inter-agent-session",
    });

    const runId = randomUUID();
    const table = buildThreadRuntimeTableNames();
    await pool.query(`
      INSERT INTO ${table.runs} (
        id, thread_id, owner_source, owner_key, owner_holder_id, status, started_at
      ) VALUES ($1, 'upgrade-thread', 'daemon', 'primary', 'old-owner', 'running', NOW())
    `, [runId]);
    // Current stores intentionally do not support historical schemas. Seed
    // the pre-0007 rows directly, as the old daemon would have written them.
    const admittedId = randomUUID();
    const wakeId = randomUUID();
    const staleInterAgentId = randomUUID();
    const legacyInputs = await pool.query(`
      INSERT INTO ${table.inputs} (
        id, thread_id, delivery_mode, source, connector_key,
        external_message_id, created_at, message
      ) VALUES
        ($1, 'upgrade-thread', 'queue', 'telegram', 'bot-1', 'admitted-before-cutover', NOW(), $4::jsonb),
        ($2, 'upgrade-thread', 'wake', 'telegram', 'bot-1', 'wake-before-cutover', NOW(), $5::jsonb),
        ($3, 'stale-inter-agent-thread', 'wake', 'subagent', NULL, 'stale-before-cutover',
          NOW() - INTERVAL '30 days', $6::jsonb)
      RETURNING id, input_order
    `, [
      admittedId,
      wakeId,
      staleInterAgentId,
      JSON.stringify({role: "user", content: "admitted", timestamp: 1}),
      JSON.stringify({role: "user", content: "wake", timestamp: 2}),
      JSON.stringify({role: "user", content: "stale", timestamp: 3}),
    ]);
    const admitted = legacyInputs.rows.find((row) => row.id === admittedId)!;
    await pool.query(`
      UPDATE ${table.inputs} SET admitted_run_id = $1 WHERE id = $2
    `, [runId, admitted.id]);
    await pool.query(`
      UPDATE "runtime"."session_runtime_config"
      SET pending_wake_at = NULL
      WHERE session_id IN ('upgrade-session', 'stale-inter-agent-session')
    `);

    // These rows deliberately use the pre-0005 shape. Instantiating the
    // current repository here would assume the very column this test adds.
    const insertLegacyRequest = async (kind: string, payload: unknown) => {
      const id = randomUUID();
      const orderingKey = `v1:${createHash("sha256").update(id).digest("hex")}`;
      await pool.query(`
        INSERT INTO "runtime"."runtime_requests" (
          id, kind, status, payload, ordering_key
        ) VALUES ($1, $2, 'pending', $3::jsonb, $4)
      `, [id, kind, JSON.stringify(payload), orderingKey]);
      return {id};
    };
    const abortRequest = await insertLegacyRequest(
      "abort_thread",
      {threadId: "upgrade-thread", reason: "upgrade receipt"},
    );
    const interruptedRequest = await insertLegacyRequest(
      "update_thread",
      {threadId: "upgrade-thread", update: {model: "openai/gpt-5.1"}},
    );
    const interruptedReset = await insertLegacyRequest(
      "reset_session",
      {source: "operator", sessionId: "upgrade-session"},
    );
    await pool.query(`
      UPDATE "runtime"."runtime_requests"
      SET status = 'running',
          claim_token = $2,
          claimed_at = NOW(),
          claim_expires_at = NOW() + INTERVAL '5 minutes'
      WHERE id = $1
    `, [interruptedRequest.id, randomUUID()]);
    await pool.query(`
      UPDATE "runtime"."runtime_requests"
      SET status = 'running',
          claim_token = $2,
          claimed_at = NOW(),
          claim_expires_at = NOW() + INTERVAL '5 minutes'
      WHERE id = $1
    `, [interruptedReset.id, randomUUID()]);
    const pristineConfigRequest = await insertLegacyRequest(
      "update_thread",
      {threadId: "upgrade-thread", update: {model: "openai/gpt-5.2"}},
    );
    const pristineInputRequest = await insertLegacyRequest(
      "tui_input",
      {
        threadId: "upgrade-thread",
        actorId: "operator",
        externalMessageId: randomUUID(),
        text: "survive cutover",
      },
    );
    await pool.query(`
      INSERT INTO ${table.abortOperations} (operation_id, thread_id, run_id, reason)
      VALUES ($1, 'upgrade-thread', $2, 'upgrade receipt'),
             ($3, 'upgrade-thread', NULL, 'orphan receipt'),
             ($4, 'upgrade-thread', $2, 'Reset requested from operator.')
    `, [abortRequest.id, runId, randomUUID(), interruptedReset.id]);

    await expect(migrator(PANDA_SCHEMA_MIGRATIONS.length).migrate()).rejects.toThrow(
      "Unsafe interrupted reset detected",
    );
    // The hard cut cannot infer whether the legacy reset's remaining effects
    // happened. An operator must resolve that one unsafe receipt explicitly;
    // after removal the append-only migration can proceed normally.
    await pool.query(`DELETE FROM "runtime"."runtime_requests" WHERE id = $1`, [interruptedReset.id]);
    await migrator(PANDA_SCHEMA_MIGRATIONS.length).migrate();

    await expect(pool.query(`
      SELECT admitted_through_input_order
      FROM ${table.runs}
      WHERE id = $1
    `, [runId])).resolves.toMatchObject({
      rows: [{admitted_through_input_order: String(admitted.input_order)}],
    });
    await expect(pool.query(`
      SELECT pending_wake_at IS NOT NULL AS pending
      FROM "runtime"."session_runtime_config"
      WHERE session_id = 'upgrade-session'
    `)).resolves.toMatchObject({rows: [{pending: true}]});
    await expect(pool.query(`
      SELECT pending_wake_at IS NOT NULL AS pending
      FROM "runtime"."session_runtime_config"
      WHERE session_id = 'stale-inter-agent-session'
    `)).resolves.toMatchObject({rows: [{pending: false}]});
    await expect(pool.query(`
      SELECT applied_at,
             discarded_at IS NOT NULL AS discarded,
             message
      FROM ${table.inputs}
      WHERE id = $1
    `, [staleInterAgentId])).resolves.toMatchObject({rows: [{
      applied_at: null,
      discarded: true,
      message: null,
    }]});
    await expect(pool.query(`
      SELECT operation_id FROM ${table.abortOperations} ORDER BY operation_id
    `)).resolves.toMatchObject({rows: [{operation_id: abortRequest.id}]});
    await expect(pool.query(`
      SELECT status, claim_token, claim_expires_at, finished_at IS NOT NULL AS finished,
             execution_attempts, error
      FROM "runtime"."runtime_requests"
      WHERE id = $1
    `, [interruptedRequest.id])).resolves.toMatchObject({rows: [{
      status: "failed",
      claim_token: null,
      claim_expires_at: null,
      finished: true,
      execution_attempts: 0,
      error: "Unsettled runtime request predates operation receipts and cannot be replayed safely.",
    }]});
    await expect(pool.query(`
      SELECT id, status, error
      FROM "runtime"."runtime_requests"
      WHERE id = ANY($1::uuid[])
      ORDER BY id
    `, [[pristineConfigRequest.id, pristineInputRequest.id]])).resolves.toMatchObject({rows: expect.arrayContaining([
      {
        id: pristineConfigRequest.id,
        status: "failed",
        error: "Unsettled runtime request predates operation receipts and cannot be replayed safely.",
      },
      {id: pristineInputRequest.id, status: "pending", error: null},
    ])});
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM information_schema.columns
      WHERE table_schema = 'runtime'
        AND table_name = 'inputs'
        AND column_name = 'admitted_run_id'
    `)).resolves.toMatchObject({rows: [{count: 0}]});
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count
      FROM pg_indexes
      WHERE schemaname = 'runtime'
        AND indexname = 'runtime_inputs_runnable_idx'
    `)).resolves.toMatchObject({rows: [{count: 0}]});

    await pool.query(`DELETE FROM "runtime"."runtime_requests" WHERE id = $1`, [abortRequest.id]);
    await expect(pool.query(`
      SELECT COUNT(*)::integer AS count FROM ${table.abortOperations}
    `)).resolves.toMatchObject({rows: [{count: 0}]});
    await expect(threads.getInput(wakeId)).resolves.toMatchObject({status: "pending"});
  });
});
