import {randomUUID} from "node:crypto";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {PANDA_SCHEMA_MIGRATIONS} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresConnectorLeaseRepo} from "../../src/domain/connector-leases/repo.js";
import {summarizeRuntimeError} from "../../src/lib/runtime-error-summary.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {readControlWorkFailures} from "../../src/domain/control/work-failures.js";
import {PostgresScheduledTaskStore} from "../../src/domain/scheduling/tasks/postgres.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {RuntimeRequestRepo} from "../../src/domain/threads/requests/repo.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {createPostgresMigrator} from "../../src/lib/postgres-migrations.js";
import type {PgPoolLike} from "../../src/lib/postgres-query.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

describe.sequential("Control failure snapshots with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let taskId: string;
  const summaryCorpus = [
    'Bad request {"messages":["hidden structured payload"]}',
    'Provider failure\nrequest body: private request payload',
    'Failure summary\n    at privateFrame (/private/path.ts:1:1)',
    '\u001b[31mTransport unavailable\u001b[0m\u0007',
    'failureKind=provider_error Runner unavailable.\nresponse body: private response',
    'First safe line\nSecond safe line\nThird hidden line',
    '{"messages":["private first line"]}',
    'A'.repeat(600),
    'Unicode žluťoučký 🐼 failure payload: hidden payload',
    null,
  ];
  const corpusIds = summaryCorpus.map(() => randomUUID());
  let legacyAbortedRunId: string;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/control-failures-live-test", max: 4});
    await createPostgresMigrator({pool, migrations: PANDA_SCHEMA_MIGRATIONS.filter((migration) => migration.id !== "0025_runtime_error_summary"), schemaName: "runtime", tableName: "schema_migrations", lockName: "panda:control-failures-live-test"}).migrate();
    const agents = new PostgresAgentStore({pool});
    const sessions = new PostgresSessionStore({pool});
    const threads = new PostgresThreadRuntimeStore({pool});
    for (const agentKey of ["panda", "private-agent"]) {
      await agents.bootstrapAgent({agentKey, displayName: agentKey});
      await sessions.createSession({id: `session-${agentKey}`, agentKey, kind: "branch", currentThreadId: `thread-${agentKey}`});
      await threads.createThread({id: `thread-${agentKey}`, sessionId: `session-${agentKey}`});
    }
    const task = await new PostgresScheduledTaskStore({pool}).createTask({
      sessionId: "session-panda", title: "Retained scheduled failure", instruction: "Synthetic fixture", schedule: {kind: "once", runAt: "2040-01-01T00:00:00.000Z"},
    });
    taskId = task.id;
    await pool.query(`
      INSERT INTO runtime.runs (id, thread_id, status, started_at, finished_at, error)
      SELECT ('10000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'thread-panda', 'failed',
        '2040-01-01'::timestamptz + i * interval '1 minute', '2040-01-01'::timestamptz + i * interval '1 minute',
        CASE WHEN i = 1 THEN 'Rare older runtime failure {"messages":["hidden payload sentinel"]}' ELSE 'Retained runtime failure ' || i::text END
      FROM generate_series(1, 1382) AS i;
      INSERT INTO runtime.runs (id, thread_id, status, started_at, finished_at, error)
      VALUES ('90000000-0000-4000-8000-000000000001', 'thread-private-agent', 'failed', '2041-01-01', '2041-01-01', 'private agent sentinel');
    `);
    await pool.query(`
      INSERT INTO runtime.scheduled_task_runs (id, task_id, session_id, scheduled_for, status, error, created_at, started_at, finished_at)
      SELECT ('20000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, $1, 'session-panda',
        '2040-02-01'::timestamptz + i * interval '1 minute', 'failed', 'Synthetic scheduled error',
        '2040-02-01'::timestamptz, '2040-02-01'::timestamptz, '2040-02-01'::timestamptz
      FROM generate_series(1, 210) AS i
    `, [taskId]);
    await pool.query(`
      INSERT INTO runtime.channel_actions (id, session_id, channel, connector_key, kind, payload, status)
      VALUES
        ('30000000-0000-4000-8000-000000000001', 'session-panda', 'telegram', 'bot-panda', 'telegram_reaction', '{}'::jsonb, 'unknown'),
        ('30000000-0000-4000-8000-000000000002', 'session-private-agent', 'telegram', 'private-bot', 'telegram_reaction', '{}'::jsonb, 'unknown'),
        ('30000000-0000-4000-8000-000000000003', NULL, 'telegram', 'unattributed-bot', 'telegram_reaction', '{}'::jsonb, 'unknown');
      INSERT INTO runtime.outbound_deliveries (id, session_id, thread_id, channel, connector_key, external_conversation_id, items, status)
      VALUES ('40000000-0000-4000-8000-000000000001', 'session-panda', NULL, 'telegram', 'bot-panda', 'chat-panda', '[]'::jsonb, 'unknown');
    `);
    for (const [index, error] of summaryCorpus.entries()) {
      await pool.query(`INSERT INTO runtime.runs (id, thread_id, status, started_at, finished_at, error)
        VALUES ($1, 'thread-private-agent', 'failed', '2040-01-01', '2040-01-01', $2)`, [corpusIds[index], error]);
    }
    const legacyOwner = {source: "panda-core", connectorKey: "control-legacy-abort", holderId: randomUUID()};
    await new PostgresConnectorLeaseRepo({pool}).tryAcquire({...legacyOwner, ttlMs: 120_000});
    await threads.requestWake("thread-private-agent");
    legacyAbortedRunId = (await threads.tryStartRun("thread-private-agent", legacyOwner, randomUUID()))!.id;
    await pool.query("UPDATE runtime.runs SET abort_requested_at = NOW(), abort_reason = $2 WHERE id = $1", [legacyAbortedRunId, "Legacy abort payload: private legacy abort body"]);
    await createPostgresMigrator({pool, migrations: PANDA_SCHEMA_MIGRATIONS, schemaName: "runtime", tableName: "schema_migrations", lockName: "panda:control-failures-live-test"}).migrate();
  });

  afterAll(async () => { await pool?.end(); });

  liveIt("reads complete retained history with one client and truthful counts", async () => {
    let acquired = 0;
    let readRows = 0;
    let readBytes = 0;
    let statements = 0;
    let snapshotQuery: {sql: string; values?: readonly unknown[]} | undefined;
    const measured: PgPoolLike = {
      query: (sql, values) => pool.query(sql, values),
      async connect() {
        acquired++;
        const client = await pool.connect();
        return {
          async query(sql, values) {
            const result = await client.query(sql, values);
            statements++;
            if (sql.includes("WITH failures AS")) snapshotQuery = {sql, values};
            readRows += result.rows.length;
            readBytes += Buffer.byteLength(JSON.stringify(result.rows));
            return result;
          },
          release: () => client.release(),
        };
      },
    };
    const started = performance.now();
    const result = await readControlWorkFailures(measured, ["panda"], {severity: "critical", perPage: 20});
    const elapsedMs = performance.now() - started;
    expect(result).toMatchObject({counts: {total: 1594, critical: 1382, warning: 212}, meta: {total: 1382, per_page: 20, last_page: 70}});
    expect(result.data).toHaveLength(20);
    expect(acquired).toBe(1);
    expect(readRows).toBeLessThanOrEqual(4);
    expect(readBytes).toBeLessThan(25_000);
    expect(statements).toBe(4);
    const explained = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${snapshotQuery!.sql}`, snapshotQuery!.values);
    const plan = explained.rows[0]!['QUERY PLAN'][0];
    const scans: Array<{relation: string; rows: number; loops: number}> = [];
    const inspect = (node: Record<string, any>) => {
      if (node['Relation Name']) scans.push({relation: node['Relation Name'], rows: node['Actual Rows'], loops: node['Actual Loops']});
      for (const child of node.Plans ?? []) inspect(child);
    };
    inspect(plan.Plan);
    expect(plan.Plan['Actual Rows']).toBe(1);
    expect(plan.Plan['Temp Written Blocks']).toBe(0);
    console.info(JSON.stringify({measurement: "control_failure_snapshot", poolMax: 4, runtimeRows: 1382, scheduledRows: 210, readRows, readBytes, statements,
      elapsedMs: Math.round(elapsedMs * 100) / 100, planningMs: plan['Planning Time'], executionMs: plan['Execution Time'],
      sharedHitBlocks: plan.Plan['Shared Hit Blocks'], tempWrittenBlocks: plan.Plan['Temp Written Blocks'], scans}));
  });

  liveIt("searches older sanitized summaries, ignores selected severity in counters, and excludes foreign agents", async () => {
    expect(await readControlWorkFailures(pool, ["panda"], {search: "Rare older"}))
      .toMatchObject({counts: {total: 1, critical: 1, warning: 0}, data: [{summary: "Rare older runtime failure"}]});
    expect((await readControlWorkFailures(pool, ["panda"], {search: "hidden payload sentinel"})).counts.total).toBe(0);
    expect((await readControlWorkFailures(pool, ["panda"], {search: "private agent sentinel"})).counts.total).toBe(0);
    expect(await readControlWorkFailures(pool, ["panda"], {kind: "scheduled_task_run", severity: "critical"}))
      .toMatchObject({data: [], counts: {total: 210, critical: 0, warning: 210}, meta: {total: 0}});
    expect(await readControlWorkFailures(pool, ["panda"], {kind: "channel_action"}))
      .toMatchObject({counts: {total: 1}, data: [{sessionId: "session-panda", summary: "Channel action outcome is unknown."}]});
    expect(await readControlWorkFailures(pool, ["panda"], {kind: "outbound_delivery"}))
      .toMatchObject({counts: {total: 1}, data: [{sessionId: "session-panda", summary: "Outbound delivery outcome is unknown."}]});
  });

  liveIt.each([
    {title: "Žilina", searches: ["Žilina", "žilina", "ŽILINA"], nonmatches: ["Zilina"]},
    {title: "İstanbul", searches: ["İstanbul", "i̇stanbul", "İSTANBUL"], nonmatches: ["istanbul"]},
    {title: "ΣΟΣ", searches: ["ΣΟΣ", "σος", "ΣοΣ"], nonmatches: ["σοσ"]},
    {title: "Straße", searches: ["Straße", "straße"], nonmatches: ["STRASSE"]},
  ])("matches Unicode title $title independently of the database locale", async ({title, searches, nonmatches}) => {
    await pool.query("UPDATE runtime.scheduled_tasks SET title = $2 WHERE id = $1", [taskId, title]);
    try {
      for (const search of searches) {
        expect(await readControlWorkFailures(pool, ["panda"], {kind: "scheduled_task_run", search, perPage: 1}))
          .toMatchObject({data: [{summary: `Scheduled task failed: ${title}`}], meta: {total: 210}, counts: {total: 210, critical: 0, warning: 210}});
      }
      for (const search of nonmatches) {
        expect(await readControlWorkFailures(pool, ["panda"], {kind: "scheduled_task_run", search}))
          .toMatchObject({data: [], meta: {total: 0}, counts: {total: 0}});
      }
    } finally {
      await pool.query("UPDATE runtime.scheduled_tasks SET title = 'Retained scheduled failure' WHERE id = $1", [taskId]);
    }
  });

  liveIt("keeps equal timestamps stable across pages and preserves counts beyond the last page", async () => {
    const input = {kind: "scheduled_task_run" as const, perPage: 100, sortBy: "createdAt", sortDirection: "desc" as const};
    const pages = await Promise.all([1, 2, 3, 4].map((page) => readControlWorkFailures(pool, ["panda"], {...input, page})));
    expect(pages.map((page) => page.data.length)).toEqual([100, 100, 10, 0]);
    const ids = pages.flatMap((page) => page.data.map((row) => row.id));
    expect(new Set(ids).size).toBe(210);
    expect(ids).toEqual([...ids].sort());
    expect(pages[3]).toMatchObject({counts: {total: 210}, meta: {current_page: 4, total: 210, last_page: 3}});
  });

  liveIt("uses one database snapshot when a source changes between reads", async () => {
    let changed = false;
    const concurrent: PgPoolLike = {
      query: (sql, values) => pool.query(sql, values),
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, values) {
            const result = await client.query(sql, values);
            if (!changed && sql.includes("information_schema.tables")) {
              changed = true;
              await pool.query("UPDATE runtime.scheduled_tasks SET title = 'Changed after snapshot' WHERE id = $1", [taskId]);
            }
            return result;
          },
          release: () => client.release(),
        };
      },
    };
    try {
      const before = await readControlWorkFailures(concurrent, ["panda"], {search: "Retained scheduled failure"});
      expect(before.counts.total).toBe(210);
      const after = await readControlWorkFailures(pool, ["panda"], {search: "Changed after snapshot"});
      expect(after.counts.total).toBe(210);
    } finally {
      await pool.query("UPDATE runtime.scheduled_tasks SET title = 'Retained scheduled failure' WHERE id = $1", [taskId]);
    }
  });

  liveIt("backfills existing failures with the frozen canonical sanitizer and keeps unknown legacy summaries generic", async () => {
    const rows = await pool.query("SELECT id, error_summary FROM runtime.runs WHERE id = ANY($1::uuid[])", [corpusIds]);
    const summaries = new Map(rows.rows.map((row) => [row.id, row.error_summary]));
    for (const [index, error] of summaryCorpus.entries()) expect(summaries.get(corpusIds[index])).toBe(summarizeRuntimeError(error));
    await new PostgresThreadRuntimeStore({pool}).completeRun(legacyAbortedRunId);
    expect((await readControlWorkFailures(pool, ["private-agent"], {search: legacyAbortedRunId})).data).toMatchObject([{summary: "Legacy abort"}]);
    const id = randomUUID();
    await pool.query(`INSERT INTO runtime.runs (id, thread_id, status, started_at, finished_at, error)
      VALUES ($1, 'thread-private-agent', 'failed', NOW(), NOW(), 'Raw legacy private sentinel')`, [id]);
    const result = await readControlWorkFailures(pool, ["private-agent"], {search: id});
    expect(result.data).toMatchObject([{summary: "Agent run failed."}]);
    expect((await readControlWorkFailures(pool, ["private-agent"], {search: "Agent run failed"})).data)
      .toContainEqual(expect.objectContaining({id: `runtime:${id}`, summary: "Agent run failed."}));
    expect((await readControlWorkFailures(pool, ["private-agent"], {search: "Raw legacy private sentinel"})).counts.total).toBe(0);
  });

  liveIt("persists safe summaries atomically for failures, abort completion and orphan recovery", async () => {
    const sessions = new PostgresSessionStore({pool});
    const threads = new PostgresThreadRuntimeStore({pool});
    const leases = new PostgresConnectorLeaseRepo({pool});
    const owner = {source: "panda-core", connectorKey: "control-summary", holderId: randomUUID()};
    await leases.tryAcquire({...owner, ttlMs: 120_000});
    const start = async () => {
      const threadId = randomUUID();
      const sessionId = `summary / 🐼 ${threadId}`;
      await sessions.createSession({id: sessionId, agentKey: "private-agent", kind: "branch", currentThreadId: threadId});
      await threads.createThread({id: threadId, sessionId});
      await threads.requestWake(threadId);
      const run = await threads.tryStartRun(threadId, owner, randomUUID());
      expect(run).not.toBeNull();
      return {threadId, sessionId, runId: run!.id};
    };
    const assertSummary = async (runId: string, summary: string | null) => {
      const row = (await pool.query("SELECT error_summary FROM runtime.runs WHERE id = $1", [runId])).rows[0];
      expect(row.error_summary).toBe(summary);
    };
    const normal = await start();
    await threads.failRun(normal.runId, 'Normal failure {"messages":["private normal body"]}');
    await assertSummary(normal.runId, "Normal failure");
    const route = `/agents/private-agent/sessions/${encodeURIComponent(normal.sessionId)}?tab=runtime`;
    expect((await readControlWorkFailures(pool, ["private-agent"], {search: route})).data).toMatchObject([{targetRoute: route}]);
    const before = await start();
    await threads.failRunBeforeExecution(before.runId, "Before execution failure payload: private before body");
    await assertSummary(before.runId, "Before execution failure");
    for (const durable of [false, true]) {
      const aborted = await start();
      const operationId = durable ? (await new RuntimeRequestRepo({pool}).enqueueRequest({kind: "abort_thread", payload: {threadId: aborted.threadId, reason: "First abort request body: private abort body"}})).id : undefined;
      await threads.requestRunAbort(aborted.threadId, "First abort request body: private abort body", operationId);
      await threads.requestRunAbort(aborted.threadId, "Later ignored abort payload: private later body");
      await threads.completeRun(aborted.runId);
      await assertSummary(aborted.runId, "First abort");
    }
    const complete = await start();
    await threads.completeRun(complete.runId);
    await assertSummary(complete.runId, null);
    const orphan = await start();
    await leases.release(owner);
    const successor = {...owner, holderId: randomUUID()};
    await leases.tryAcquire({...successor, ttlMs: 120_000});
    expect(await threads.failOrphanedRuns(successor, "Orphan recovery response body: private orphan body", 10)).toMatchObject([{id: orphan.runId}]);
    await assertSummary(orphan.runId, "Orphan recovery");
    for (const hidden of ["private normal body", "private before body", "private abort body", "private later body", "private orphan body"]) {
      expect((await readControlWorkFailures(pool, ["private-agent"], {search: hidden})).counts.total).toBe(0);
    }
  });

  liveIt("treats wildcard characters as literal search and serves concurrent snapshots with a small pool", async () => {
    expect((await readControlWorkFailures(pool, ["panda"], {search: "%"})).counts.total).toBe(0);
    expect((await readControlWorkFailures(pool, ["panda"], {search: "_' OR true --"})).counts.total).toBe(0);
    const pages = await Promise.all(Array.from({length: 12}, (_, index) => readControlWorkFailures(pool, ["panda"], {page: index + 1, perPage: 1})));
    expect(pages.every((page) => page.counts.total === 1594 && page.data.length === 1)).toBe(true);
  });

  liveIt("distinguishes absent optional sources from broken required or configured sources", async () => {
    await pool.query("ALTER TABLE runtime.channel_actions RENAME TO channel_actions_unavailable");
    try {
      expect((await readControlWorkFailures(pool, ["panda"], {kind: "channel_action"})).counts.total).toBe(0);
      await pool.query("CREATE TABLE runtime.channel_actions (id TEXT)");
      await expect(readControlWorkFailures(pool, ["panda"], {kind: "channel_action"}))
        .rejects.toMatchObject({message: "Work failure snapshot could not be read."});
      await pool.query("DROP TABLE runtime.channel_actions");
    } finally {
      await pool.query("ALTER TABLE runtime.channel_actions_unavailable RENAME TO channel_actions");
    }
    await pool.query("ALTER TABLE runtime.runs RENAME TO runs_unavailable");
    try {
      await expect(readControlWorkFailures(pool, ["panda"]))
        .rejects.toMatchObject({message: "Work failure snapshot could not be read."});
      expect((await readControlWorkFailures(pool, ["panda"], {kind: "scheduled_task_run"})).counts.total).toBe(210);
    } finally {
      await pool.query("ALTER TABLE runtime.runs_unavailable RENAME TO runs");
    }
  });


  liveIt("bounds application reads amid substantial synthetic healthy history", async () => {
    await pool.query(`
      INSERT INTO runtime.runs (id, thread_id, status, started_at, finished_at)
      SELECT ('50000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, 'thread-panda', 'completed',
        '2042-01-01'::timestamptz + i * interval '1 minute', '2042-01-01'::timestamptz + i * interval '1 minute'
      FROM generate_series(1, 50000) AS i
    `);
    await pool.query(`
      INSERT INTO runtime.scheduled_task_runs (id, task_id, session_id, scheduled_for, status, created_at, started_at, finished_at, lineage_recorded_at)
      SELECT ('60000000-0000-4000-8000-' || lpad(i::text, 12, '0'))::uuid, $1, 'session-panda',
        '2042-01-01'::timestamptz + i * interval '1 minute', 'succeeded',
        '2042-01-01'::timestamptz, '2042-01-01'::timestamptz, '2042-01-01'::timestamptz, '2042-01-01'::timestamptz
      FROM generate_series(1, 5000) AS i
    `, [taskId]);
    await pool.query("ANALYZE runtime.runs; ANALYZE runtime.scheduled_task_runs; ANALYZE runtime.agent_sessions; ANALYZE runtime.threads");
    let readRows = 0;
    let readBytes = 0;
    let statements = 0;
    let snapshotQuery: {sql: string; values?: readonly unknown[]} | undefined;
    const measured: PgPoolLike = {
      query: (sql, values) => pool.query(sql, values),
      async connect() {
        const client = await pool.connect();
        return {
          async query(sql, values) {
            const result = await client.query(sql, values);
            statements++;
            readRows += result.rows.length;
            readBytes += Buffer.byteLength(JSON.stringify(result.rows));
            if (sql.includes("WITH failures AS")) snapshotQuery = {sql, values};
            return result;
          },
          release: () => client.release(),
        };
      },
    };
    const started = performance.now();
    const result = await readControlWorkFailures(measured, ["panda"], {severity: "critical", perPage: 20});
    const elapsedMs = performance.now() - started;
    expect(result).toMatchObject({counts: {total: 1594, critical: 1382, warning: 212}, meta: {total: 1382}});
    expect(result.data).toHaveLength(20);
    expect(readRows).toBeLessThanOrEqual(4);
    expect(readBytes).toBeLessThan(25_000);
    expect(statements).toBe(4);
    const explained = await pool.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${snapshotQuery!.sql}`, snapshotQuery!.values);
    const plan = explained.rows[0]!['QUERY PLAN'][0];
    const scans: Array<{relation: string; node: string; index?: string; rows: number; removed: number; loops: number}> = [];
    const inspect = (node: Record<string, any>) => {
      if (node['Relation Name']) scans.push({relation: node['Relation Name'], node: node['Node Type'], index: node['Index Name'], rows: node['Actual Rows'], removed: node['Rows Removed by Filter'] ?? 0, loops: node['Actual Loops']});
      for (const child of node.Plans ?? []) inspect(child);
    };
    inspect(plan.Plan);
    expect(plan.Plan['Actual Rows']).toBe(1);
    expect(plan.Plan['Temp Written Blocks']).toBe(0);
    console.info(JSON.stringify({measurement: "control_failure_synthetic_healthy_history", healthyRuntimeRows: 50000, healthyScheduledRows: 5000,
      readRows, readBytes, statements, elapsedMs: Math.round(elapsedMs * 100) / 100,
      planningMs: plan['Planning Time'], executionMs: plan['Execution Time'], sharedHitBlocks: plan.Plan['Shared Hit Blocks'],
      tempWrittenBlocks: plan.Plan['Temp Written Blocks'], scans}));
  });

});
