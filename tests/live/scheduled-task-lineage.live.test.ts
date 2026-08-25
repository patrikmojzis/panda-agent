import {randomUUID} from "node:crypto";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {PRE_LEDGER_BASELINE_MIGRATION} from "../../src/app/database/migrations/0001-pre-ledger-baseline.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresIdentityStore} from "../../src/domain/identity/postgres.js";
import {PostgresScheduledTaskStore} from "../../src/domain/scheduling/tasks/postgres.js";
import {buildScheduledTaskTableNames} from "../../src/domain/scheduling/tasks/postgres-shared.js";
import type {ScheduledTaskRecord} from "../../src/domain/scheduling/tasks/types.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {buildThreadRuntimeTableNames} from "../../src/domain/threads/runtime/postgres-shared.js";
import {stringToUserMessage} from "../../src/kernel/agent/helpers/input.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

function planNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(planNodes);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(planNodes)];
}

describe("scheduled task occurrence lineage on PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let tasks: PostgresScheduledTaskStore;
  let threads: PostgresThreadRuntimeStore;
  const threadTables = buildThreadRuntimeTableNames();
  const scheduledTables = buildScheduledTaskTableNames();

  beforeAll(async () => {
    if (!databaseUrl) return;

    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/scheduled-task-lineage-live-test",
      max: 16,
    });
    const identities = new PostgresIdentityStore({pool});
    const agents = new PostgresAgentStore({pool});
    const sessions = new PostgresSessionStore({pool});
    threads = new PostgresThreadRuntimeStore({pool});
    tasks = new PostgresScheduledTaskStore({pool});
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await identities.createIdentity({
      id: "scheduled-test-identity",
      handle: "scheduled-test",
      displayName: "Scheduled Test",
    });
    await sessions.createSession({
      id: "scheduled-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "scheduled-thread-a",
      createdByIdentityId: "scheduled-test-identity",
    });
    await threads.createThread({id: "scheduled-thread-a", sessionId: "scheduled-session"});
    await threads.createThread({id: "scheduled-thread-b", sessionId: "scheduled-session"});
    await sessions.createSession({
      id: "scheduled-session-secondary",
      agentKey: "panda",
      kind: "branch",
      currentThreadId: "scheduled-thread-secondary",
      createdByIdentityId: "scheduled-test-identity",
    });
    await threads.createThread({id: "scheduled-thread-secondary", sessionId: "scheduled-session-secondary"});
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createDueTask(title: string): Promise<ScheduledTaskRecord> {
    return tasks.createTask({
      sessionId: "scheduled-session",
      createdByIdentityId: "scheduled-test-identity",
      title,
      instruction: `Execute ${title}.`,
      schedule: {
        kind: "once",
        runAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
  }

  async function rerunPreLedgerMigration(): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // These probes deliberately replay the frozen legacy bridge. Bypassing the
      // append-only ledger keeps its prefix history truthful while exercising 0001.
      await PRE_LEDGER_BASELINE_MIGRATION.apply({queryable: client});
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  liveIt("materializes and claims one occurrence under concurrency, then fences its token", async () => {
    const task = await createDueTask("concurrent occurrence");
    const request = {
      runs: [{taskId: task.id, scheduledFor: task.nextFireAt!, nextFireAt: undefined}],
    };
    const materialized = (await Promise.all(
      Array.from({length: 12}, () => tasks.materializeTaskRuns(request)),
    )).flat();
    expect(materialized).toHaveLength(1);
    expect(materialized[0]).toMatchObject({taskId: task.id, status: "pending"});
    await expect(tasks.getTask(task.id)).resolves.toMatchObject({nextFireAt: undefined});

    const claims = await Promise.all(Array.from({length: 12}, () => tasks.claimTaskRun({
      claimedBy: "concurrency-test",
      claimTtlMs: 60_000,
    })));
    const owned = claims.filter((claim) => claim?.run.id === materialized[0]!.id);
    expect(owned).toHaveLength(1);
    const claim = owned[0]!;
    expect(claim!.run).toMatchObject({status: "claimed", claimToken: expect.any(String)});

    await expect(tasks.failTaskRun({
      runId: claim!.run.id,
      claimToken: randomUUID(),
      error: "stale owner",
    })).rejects.toThrow("claim expired or its execution receipt does not match");
    await expect(tasks.failTaskRun({
      runId: claim!.run.id,
      claimToken: claim!.run.claimToken,
      error: "fixture completed before delivery",
    })).resolves.toMatchObject({status: "failed"});
  });

  liveIt("serializes recurring catch-up per task without blocking unrelated due work", async () => {
    const recurring = await tasks.createTask({
      sessionId: "scheduled-session",
      createdByIdentityId: "scheduled-test-identity",
      title: "sequential recurring catch-up",
      instruction: "Run one occurrence at a time.",
      schedule: {kind: "recurring", cron: "* * * * *", timezone: "UTC"},
    });
    const firstFire = Date.now() - 120_000;
    const secondFire = firstFire + 60_000;
    await pool.query(`
      UPDATE ${scheduledTables.scheduledTasks}
      SET next_fire_at = $2
      WHERE id = $1
    `, [recurring.id, new Date(firstFire)]);
    const [firstOccurrence] = await tasks.materializeTaskRuns({
      runs: [{taskId: recurring.id, scheduledFor: firstFire, nextFireAt: secondFire}],
    });
    expect(firstOccurrence).toMatchObject({taskId: recurring.id, status: "pending"});

    const unrelated = await createDueTask("unrelated work during recurring catch-up");
    const materialized = await tasks.materializeTaskRuns({
      runs: [
        {taskId: recurring.id, scheduledFor: secondFire, nextFireAt: secondFire + 60_000},
        {taskId: unrelated.id, scheduledFor: unrelated.nextFireAt!, nextFireAt: undefined},
      ],
    });
    expect(materialized).toHaveLength(1);
    expect(materialized[0]).toMatchObject({taskId: unrelated.id, status: "pending"});
    await expect(tasks.getTask(recurring.id)).resolves.toMatchObject({nextFireAt: secondFire});

    const claim = await tasks.claimTaskRun({claimedBy: "recurring-serialization-test", claimTtlMs: 60_000});
    expect(claim?.run.id).toBe(firstOccurrence!.id);
    await tasks.failTaskRun({
      runId: firstOccurrence!.id,
      claimToken: claim!.run.claimToken,
      error: "first catch-up occurrence settled",
    });
    await expect(tasks.updateTask({
      taskId: recurring.id,
      sessionId: recurring.sessionId,
      schedule: {kind: "once", runAt: new Date(firstFire).toISOString()},
    })).rejects.toThrow("already has an occurrence");
    await expect(tasks.materializeTaskRuns({
      runs: [{taskId: recurring.id, scheduledFor: secondFire, nextFireAt: secondFire + 60_000}],
    })).resolves.toEqual([expect.objectContaining({taskId: recurring.id, status: "pending"})]);

    await tasks.cancelTask({taskId: recurring.id, sessionId: recurring.sessionId});
    await tasks.cancelTask({taskId: unrelated.id, sessionId: unrelated.sessionId});
  });

  liveIt("rejects an unrelated input that collides with an occurrence UUID", async () => {
    const task = await createDueTask("input fingerprint collision");
    const [occurrence] = await tasks.materializeTaskRuns({
      runs: [{taskId: task.id, scheduledFor: task.nextFireAt!, nextFireAt: undefined}],
    });
    const claim = await tasks.claimTaskRun({claimedBy: "collision-test", claimTtlMs: 60_000});
    expect(claim?.run.id).toBe(occurrence!.id);
    await threads.enqueueInput("scheduled-thread-a", {
      source: "tui",
      externalMessageId: "unrelated-input",
      message: stringToUserMessage("attempt to poison a scheduled occurrence id"),
    }, "wake", {inputId: occurrence!.id});
    await expect(tasks.startTaskRun({
      runId: occurrence!.id,
      claimToken: claim!.run.claimToken,
    })).rejects.toThrow("execution receipt does not match");
    await expect(threads.enqueueInput("scheduled-thread-a", {
      source: "scheduled_task",
      externalMessageId: occurrence!.id,
      message: stringToUserMessage("execute exact receipt"),
    }, "wake", {inputId: occurrence!.id})).rejects.toThrow("did not resolve to a durable input");
    await expect(tasks.failTaskRun({
      runId: occurrence!.id,
      claimToken: claim!.run.claimToken,
      error: "stable input UUID collided with unrelated input",
    })).resolves.toMatchObject({status: "failed", threadInputId: undefined});
  });

  liveIt("settles only the exact terminal run recorded on the scheduled input", async () => {
    const task = await createDueTask("exact receipt");
    const [occurrence] = await tasks.materializeTaskRuns({
      runs: [{taskId: task.id, scheduledFor: task.nextFireAt!, nextFireAt: undefined}],
    });
    const claim = await tasks.claimTaskRun({claimedBy: "receipt-test", claimTtlMs: 60_000});
    expect(claim?.run.id).toBe(occurrence!.id);

    const enqueue = await threads.enqueueInput("scheduled-thread-a", {
      source: "scheduled_task",
      externalMessageId: occurrence!.id,
      message: stringToUserMessage("execute exact receipt"),
    }, "wake", {inputId: occurrence!.id});
    await expect(tasks.failTaskRun({
      runId: occurrence!.id,
      claimToken: claim!.run.claimToken,
      error: "enqueue committed but linkage response was lost",
    })).rejects.toThrow("execution receipt does not match");
    await tasks.startTaskRun({
      runId: occurrence!.id,
      claimToken: claim!.run.claimToken,
    });

    const appliedRunId = randomUUID();
    const unrelatedRunId = randomUUID();
    await pool.query(`
      INSERT INTO ${threadTables.runs} (id, thread_id, status, started_at, finished_at)
      VALUES
        ($1, 'scheduled-thread-a', 'completed', NOW(), NOW()),
        ($2, 'scheduled-thread-a', 'completed', NOW(), NOW())
    `, [appliedRunId, unrelatedRunId]);
    await pool.query(`
      UPDATE ${threadTables.inputs}
      SET applied_at = NOW(),
          applied_run_id = $2,
          message = NULL,
          metadata = NULL
      WHERE id = $1
    `, [enqueue.input.id, appliedRunId]);

    await expect(tasks.failTaskRun({
      runId: occurrence!.id,
      claimToken: claim!.run.claimToken,
      error: "transient waiter failure is not an execution receipt",
    })).rejects.toThrow("execution receipt does not match");
    await expect(tasks.failTaskRun({
      runId: occurrence!.id,
      claimToken: claim!.run.claimToken,
      threadRunId: appliedRunId,
      error: "a completed thread run cannot prove failure",
    })).rejects.toThrow("execution receipt does not match");
    await expect(tasks.completeTaskRun({
      runId: occurrence!.id,
      claimToken: claim!.run.claimToken,
      threadRunId: unrelatedRunId,
    })).rejects.toThrow("execution receipt does not match");
    await expect(tasks.completeTaskRun({
      runId: occurrence!.id,
      claimToken: claim!.run.claimToken,
      threadRunId: appliedRunId,
    })).resolves.toMatchObject({
      status: "succeeded",
      threadInputId: enqueue.input.id,
      threadRunId: appliedRunId,
      resolvedThreadId: "scheduled-thread-a",
    });
    // This test applies the receipt with direct SQL and therefore does not
    // create the canonical transcript message that the real runtime creates.
    // Remove that synthetic input before exercising the global legacy
    // backfill below; the occurrence keeps its terminal run lineage.
    await pool.query(`DELETE FROM ${threadTables.inputs} WHERE id = $1`, [enqueue.input.id]);
  });

  liveIt("cancels unclaimed occurrences but lets an already-claimed occurrence settle", async () => {
    const pendingTask = await createDueTask("cancel pending");
    const [pending] = await tasks.materializeTaskRuns({
      runs: [{taskId: pendingTask.id, scheduledFor: pendingTask.nextFireAt!, nextFireAt: undefined}],
    });
    await tasks.cancelTask({taskId: pendingTask.id, sessionId: pendingTask.sessionId});
    await expect(tasks.listTaskRuns({
      taskId: pendingTask.id,
      sessionId: pendingTask.sessionId,
    })).resolves.toEqual([expect.objectContaining({id: pending!.id, status: "cancelled"})]);

    const claimedTask = await createDueTask("cancel after claim");
    const [claimedOccurrence] = await tasks.materializeTaskRuns({
      runs: [{taskId: claimedTask.id, scheduledFor: claimedTask.nextFireAt!, nextFireAt: undefined}],
    });
    const claim = await tasks.claimTaskRun({claimedBy: "cancel-test", claimTtlMs: 60_000});
    expect(claim?.run.id).toBe(claimedOccurrence!.id);
    await tasks.cancelTask({taskId: claimedTask.id, sessionId: claimedTask.sessionId});
    await expect(tasks.listTaskRuns({
      taskId: claimedTask.id,
      sessionId: claimedTask.sessionId,
    })).resolves.toEqual([expect.objectContaining({status: "claimed"})]);
    await expect(tasks.failTaskRun({
      runId: claimedOccurrence!.id,
      claimToken: claim!.run.claimToken,
      error: "cancelled definition finished its owned occurrence",
    })).resolves.toMatchObject({status: "failed"});
  });

  liveIt("reclaims an expired occurrence and permanently fences the old token", async () => {
    const task = await createDueTask("expired claim");
    const [occurrence] = await tasks.materializeTaskRuns({
      runs: [{taskId: task.id, scheduledFor: task.nextFireAt!, nextFireAt: undefined}],
    });
    const first = await tasks.claimTaskRun({claimedBy: "owner-a", claimTtlMs: 60_000});
    expect(first?.run.id).toBe(occurrence!.id);
    await expect(tasks.renewTaskRunClaim({
      runId: occurrence!.id,
      claimToken: randomUUID(),
      claimTtlMs: 60_000,
    })).resolves.toBeNull();
    await pool.query(`
      UPDATE ${scheduledTables.scheduledTaskRuns}
      SET claim_expires_at = NOW() - INTERVAL '1 second'
      WHERE id = $1
    `, [occurrence!.id]);

    const second = await tasks.claimTaskRun({claimedBy: "owner-b", claimTtlMs: 60_000});
    expect(second?.run.id).toBe(occurrence!.id);
    expect(second!.run.claimToken).not.toBe(first!.run.claimToken);
    await expect(tasks.failTaskRun({
      runId: occurrence!.id,
      claimToken: first!.run.claimToken,
      error: "stale settlement",
    })).rejects.toThrow("claim expired or its execution receipt does not match");
    await expect(tasks.failTaskRun({
      runId: occurrence!.id,
      claimToken: second!.run.claimToken,
      error: "new owner settled",
    })).resolves.toMatchObject({status: "failed", claimedBy: "owner-b"});
  });

  liveIt("keeps terminal history out of the claim plan", async () => {
    const historyTask = await createDueTask("large terminal history");
    await pool.query(`
      INSERT INTO ${scheduledTables.scheduledTaskRuns} (
        id,
        task_id,
        session_id,
        scheduled_for,
        status,
        error,
        created_at,
        finished_at
      )
      SELECT
        ('10000000-0000-4000-8000-' || LPAD(ordinal::text, 12, '0'))::uuid,
        $1,
        'scheduled-session',
        NOW() - (ordinal * INTERVAL '1 minute'),
        'failed',
        'historical fixture',
        NOW() - (ordinal * INTERVAL '1 minute'),
        NOW() - (ordinal * INTERVAL '1 minute')
      FROM GENERATE_SERIES(1, 10000) AS ordinal
    `, [historyTask.id]);
    await pool.query(`ANALYZE ${scheduledTables.scheduledTaskRuns}`);

    const dueTask = await createDueTask("claim plan target");
    const [occurrence] = await tasks.materializeTaskRuns({
      runs: [{taskId: dueTask.id, scheduledFor: dueTask.nextFireAt!, nextFireAt: undefined}],
    });
    const plan = await pool.query(`
      EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT run.id
      FROM ${scheduledTables.scheduledTaskRuns} AS run
      INNER JOIN ${scheduledTables.scheduledTasks} AS task ON task.id = run.task_id
      WHERE run.status IN ('pending', 'claimed', 'running')
        AND (run.status IN ('claimed', 'running') OR task.cancelled_at IS NULL)
        AND (
          run.claim_token IS NULL
          OR run.claim_expires_at IS NULL
          OR run.claim_expires_at <= NOW()
        )
      ORDER BY run.scheduled_for ASC, run.id ASC
      FOR UPDATE OF run SKIP LOCKED
      LIMIT 1
    `);
    const planText = JSON.stringify(plan.rows[0]);
    expect(planText).toMatch(/runtime_scheduled_task_runs_(claimable|active_task)_idx/);

    const claim = await tasks.claimTaskRun({claimedBy: "history-plan-test", claimTtlMs: 60_000});
    expect(claim?.run.id).toBe(occurrence!.id);
    await tasks.failTaskRun({
      runId: occurrence!.id,
      claimToken: claim!.run.claimToken,
      error: "history plan fixture complete",
    });

    const secondaryTask = await tasks.createTask({
      sessionId: "scheduled-session-secondary",
      createdByIdentityId: "scheduled-test-identity",
      title: "secondary session history",
      instruction: "Verify fair latest-run reads.",
      schedule: {kind: "once", runAt: new Date(Date.now() - 60_000).toISOString()},
    });
    await pool.query(`
      INSERT INTO ${scheduledTables.scheduledTasks} (
        id, session_id, created_by_identity_id, title, instruction,
        schedule_kind, run_at, enabled, next_fire_at, created_at, updated_at
      )
      SELECT
        MD5('home-task-' || ordinal::text)::uuid,
        'scheduled-session',
        'scheduled-test-identity',
        'home task ' || ordinal::text,
        'Verify bounded home reads.',
        'once',
        NOW() + (ordinal * INTERVAL '1 minute'),
        TRUE,
        NOW() + (ordinal * INTERVAL '1 minute'),
        NOW(),
        NOW()
      FROM GENERATE_SERIES(1, 10000) AS ordinal
    `);
    await pool.query(`ANALYZE ${scheduledTables.scheduledTasks}`);
    const homeTasksSql = `
      SELECT task.*
      FROM UNNEST($1::text[]) AS requested_session(session_id)
      CROSS JOIN LATERAL (
        SELECT candidate.id, candidate.session_id, candidate.next_fire_at, candidate.created_at
        FROM ${scheduledTables.scheduledTasks} AS candidate
        WHERE candidate.session_id = requested_session.session_id
          AND candidate.enabled = TRUE
          AND candidate.completed_at IS NULL
          AND candidate.cancelled_at IS NULL
          AND candidate.next_fire_at IS NOT NULL
        ORDER BY candidate.next_fire_at ASC NULLS LAST, candidate.created_at DESC, candidate.id ASC
        LIMIT 30
      ) AS task
      ORDER BY task.session_id ASC, task.next_fire_at ASC NULLS LAST, task.created_at DESC, task.id ASC
    `;
    const homeTasks = await pool.query(homeTasksSql, [[
      "scheduled-session",
      "scheduled-session-secondary",
    ]]);
    expect(homeTasks.rows.filter((row) => row.session_id === "scheduled-session")).toHaveLength(30);
    expect(homeTasks.rows).toContainEqual(expect.objectContaining({id: secondaryTask.id}));
    const homeTasksPlan = await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      ${homeTasksSql}
    `, [["scheduled-session", "scheduled-session-secondary"]]);
    const homeTaskIndexNodes = planNodes(homeTasksPlan.rows[0]).filter((node) => (
      String(node["Index Name"] ?? "").includes("scheduled_tasks_session_fire_idx")
    ));
    expect(homeTaskIndexNodes.length).toBeGreaterThan(0);
    expect(homeTaskIndexNodes.every((node) => Number(node["Actual Rows"]) <= 30)).toBe(true);

    await pool.query(`
      INSERT INTO ${scheduledTables.scheduledTaskRuns} (
        id, task_id, session_id, scheduled_for, status, error, created_at, finished_at
      ) VALUES ($1, $2, 'scheduled-session-secondary', NOW() - INTERVAL '1 day', 'failed', 'fixture', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
    `, [randomUUID(), secondaryTask.id]);
    const sessionIds = ["scheduled-session", "scheduled-session-secondary"];
    const latestBySessionSql = `
      SELECT latest_run.*
      FROM UNNEST($1::text[]) AS requested_session(session_id)
      CROSS JOIN LATERAL (
        SELECT id, task_id, session_id, status, scheduled_for, created_at, finished_at
        FROM ${scheduledTables.scheduledTaskRuns} AS run
        WHERE run.session_id = requested_session.session_id
        ORDER BY run.created_at DESC, run.id ASC
        LIMIT 1
      ) AS latest_run
      ORDER BY latest_run.session_id ASC
    `;
    const latestBySession = await pool.query(latestBySessionSql, [sessionIds]);
    expect(latestBySession.rows).toHaveLength(2);
    expect(latestBySession.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({session_id: "scheduled-session"}),
      expect.objectContaining({session_id: "scheduled-session-secondary", status: "failed"}),
    ]));
    const sessionPlan = await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      ${latestBySessionSql}
    `, [["scheduled-session", "scheduled-session-secondary"]]);
    const sessionIndexNodes = planNodes(sessionPlan.rows[0]).filter((node) => (
      node["Index Name"] === "runtime_scheduled_task_runs_session_created_idx"
    ));
    expect(sessionIndexNodes.length).toBeGreaterThan(0);
    expect(sessionIndexNodes.every((node) => Number(node["Actual Rows"]) <= 1)).toBe(true);

    const recentTaskIds = [historyTask.id, dueTask.id];
    const recentRunsSql = `
      SELECT recent_run.*
      FROM UNNEST($1::uuid[]) AS requested_task(task_id)
      CROSS JOIN LATERAL (
        SELECT run.id, run.task_id, run.status, run.created_at
        FROM ${scheduledTables.scheduledTaskRuns} AS run
        WHERE run.session_id = 'scheduled-session'
          AND run.task_id = requested_task.task_id
        ORDER BY run.created_at DESC, run.id ASC
        LIMIT 3
      ) AS recent_run
      ORDER BY recent_run.task_id ASC, recent_run.created_at DESC, recent_run.id ASC
    `;
    const recentRuns = await pool.query(recentRunsSql, [recentTaskIds]);
    expect(recentRuns.rows.filter((row) => row.task_id === historyTask.id)).toHaveLength(3);
    expect(recentRuns.rows.filter((row) => row.task_id === dueTask.id)).toHaveLength(1);
    const recentPlan = await pool.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      ${recentRunsSql}
    `, [recentTaskIds]);
    const taskIndexNodes = planNodes(recentPlan.rows[0]).filter((node) => (
      String(node["Index Name"] ?? "").includes("scheduled_task_runs_task_created_idx")
    ));
    expect(taskIndexNodes.length).toBeGreaterThan(0);
    expect(taskIndexNodes.every((node) => Number(node["Actual Rows"]) <= 3)).toBe(true);
  });

  liveIt("upgrades successful legacy rows that predate exact lineage", async () => {
    const task = await createDueTask("legacy success without receipt");
    await pool.query(`
      ALTER TABLE ${scheduledTables.scheduledTaskRuns}
      DROP CONSTRAINT "runtime_scheduled_task_runs_lifecycle_check"
    `);
    const legacyRunId = randomUUID();
    await pool.query(`
      INSERT INTO ${scheduledTables.scheduledTaskRuns} (
        id, task_id, session_id, scheduled_for, status, created_at, started_at, finished_at
      ) VALUES ($1, $2, 'scheduled-session', NOW(), 'succeeded', NOW(), NOW(), NOW())
    `, [legacyRunId, task.id]);

    await rerunPreLedgerMigration();

    const migrated = await pool.query(`
      SELECT lineage_recorded_at
      FROM ${scheduledTables.scheduledTaskRuns}
      WHERE id = $1
    `, [legacyRunId]);
    expect(migrated.rows[0]).toMatchObject({lineage_recorded_at: expect.any(Date)});
  });

  liveIt("fails legacy duplicate occurrences with an actionable preflight", async () => {
    const task = await createDueTask("duplicate legacy occurrence");
    await pool.query(`
      DROP INDEX "runtime"."runtime_scheduled_task_runs_task_fire_idx"
    `);
    await pool.query(`
      INSERT INTO ${scheduledTables.scheduledTaskRuns} (
        id, task_id, session_id, scheduled_for, status, error, created_at, finished_at
      ) VALUES
        ($1, $3, 'scheduled-session', $4, 'failed', 'legacy duplicate one', NOW(), NOW()),
        ($2, $3, 'scheduled-session', $4, 'failed', 'legacy duplicate two', NOW(), NOW())
    `, [randomUUID(), randomUUID(), task.id, new Date()]);

    await expect(rerunPreLedgerMigration()).rejects.toThrow(
      "duplicate scheduled_task_runs (task_id, scheduled_for) occurrences (1 row)",
    );
  });
});
