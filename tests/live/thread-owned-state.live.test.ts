import {randomUUID} from "node:crypto";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresConnectorLeaseRepo} from "../../src/domain/connector-leases/repo.js";
import {POSTGRES_CONNECTOR_LEASE_TABLE} from "../../src/domain/connector-leases/postgres-schema.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import type {ThreadRunOwner} from "../../src/domain/threads/runtime/types.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

describe("run-owned runtime state on PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let threadStore: PostgresThreadRuntimeStore;
  const ownerA: ThreadRunOwner = {
    source: "panda-core",
    connectorKey: "primary",
    holderId: "thread-state-owner-a",
  };
  const ownerB: ThreadRunOwner = {
    source: "panda-core",
    connectorKey: "primary",
    holderId: "thread-state-owner-b",
  };

  beforeAll(async () => {
    if (!databaseUrl) {
      return;
    }

    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/thread-owned-state-live-test",
      max: 8,
    });
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();

    const agents = new PostgresAgentStore({pool});
    const sessions = new PostgresSessionStore({pool});
    const connectorLeases = new PostgresConnectorLeaseRepo({pool});
    threadStore = new PostgresThreadRuntimeStore({pool});
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await sessions.createSession({
      id: "owned-state-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "owned-state-thread",
    });
    await threadStore.createThread({
      id: "owned-state-thread",
      sessionId: "owned-state-session",
    });
    await connectorLeases.tryAcquire({...ownerA, ttlMs: 120_000});
  });

  afterAll(async () => {
    await pool?.end();
  });

  liveIt("fences shell and background-job writes at daemon takeover", async () => {
    await threadStore.requestWake("owned-state-thread");
    const runA = await threadStore.tryStartRun("owned-state-thread", ownerA, randomUUID());
    expect(runA).not.toBeNull();

    await expect(threadStore.upsertShellSession({
      sessionId: "owned-state-session",
      threadId: "owned-state-thread",
      executionEnvironmentId: "default",
      runId: runA!.id,
      shellSession: {cwd: "/workspace/owner-a", env: {OWNER: "a"}},
    })).resolves.toMatchObject({shellSession: {cwd: "/workspace/owner-a"}});

    const backgroundJob = await threadStore.createToolJob({
      id: "10000000-0000-4000-8000-000000000001",
      threadId: "owned-state-thread",
      runId: runA!.id,
      kind: "bash",
      summary: "sleep 30",
      result: {mode: "local"},
    });
    await expect(threadStore.updateToolJob(backgroundJob.id, {
      progress: {status: "running"},
    })).resolves.toMatchObject({progress: {status: "running"}});

    await pool.query(`
      UPDATE ${POSTGRES_CONNECTOR_LEASE_TABLE}
      SET holder_id = $3,
          leased_until = NOW() + INTERVAL '2 minutes',
          updated_at = NOW()
      WHERE source = $1
        AND connector_key = $2
    `, [ownerB.source, ownerB.connectorKey, ownerB.holderId]);

    await expect(threadStore.upsertShellSession({
      sessionId: "owned-state-session",
      threadId: "owned-state-thread",
      executionEnvironmentId: "default",
      runId: runA!.id,
      shellSession: {cwd: "/workspace/stale", env: {OWNER: "stale"}},
    })).rejects.toThrow("is no longer owned by this daemon");
    await expect(threadStore.updateToolJob(backgroundJob.id, {
      progress: {status: "stale"},
    })).rejects.toThrow("is no longer owned by this daemon");

    await expect(threadStore.failOrphanedRuns(ownerB, "daemon owner changed", 100)).resolves.toHaveLength(1);
    await expect(threadStore.markOrphanedToolJobsLost(ownerB, "daemon owner changed", 100)).resolves.toBe(1);
    await expect(threadStore.getToolJob(backgroundJob.id)).resolves.toMatchObject({
      status: "lost",
      statusReason: "daemon owner changed",
    });

    await threadStore.requestWake("owned-state-thread");
    const runB = await threadStore.tryStartRun("owned-state-thread", ownerB, randomUUID());
    expect(runB).not.toBeNull();
    await threadStore.upsertShellSession({
      sessionId: "owned-state-session",
      threadId: "owned-state-thread",
      executionEnvironmentId: "default",
      runId: runB!.id,
      shellSession: {cwd: "/workspace/owner-b", env: {OWNER: "b"}},
    });
    await expect(threadStore.listShellSessions({sessionId: "owned-state-session"})).resolves.toEqual({
      default: {cwd: "/workspace/owner-b", env: {OWNER: "b"}},
    });
  });

  liveIt("assigns command ordinals only inside the active owned run", async () => {
    const [run] = await threadStore.listRuns("owned-state-thread").then((runs) => (
      runs.filter((candidate) => candidate.status === "running")
    ));
    expect(run?.owner).toEqual(ownerB);

    const first = await threadStore.createToolJob({
      id: "10000000-0000-4000-8000-000000000002",
      threadId: "owned-state-thread",
      runId: run!.id,
      parentToolCallId: "parent-call",
      kind: "command",
      summary: "watch.list",
    });
    const second = await threadStore.createToolJob({
      id: "10000000-0000-4000-8000-000000000003",
      threadId: "owned-state-thread",
      runId: run!.id,
      parentToolCallId: "parent-call",
      kind: "command",
      summary: "schedule.list",
    });
    expect([first.commandOrdinal, second.commandOrdinal]).toEqual([1, 2]);
    await threadStore.updateToolJob(first.id, {status: "completed", finishedAt: Date.now()});
    await threadStore.updateToolJob(second.id, {status: "completed", finishedAt: Date.now()});

    await threadStore.completeRun(run!.id);
    await expect(threadStore.createToolJob({
      id: "10000000-0000-4000-8000-000000000004",
      threadId: "owned-state-thread",
      runId: run!.id,
      parentToolCallId: "parent-call",
      kind: "command",
      summary: "should.fail",
    })).rejects.toThrow("is no longer owned by this daemon");
  });

  liveIt("fences standalone background jobs with the daemon owner after takeover", async () => {
    await pool.query(`
      UPDATE ${POSTGRES_CONNECTOR_LEASE_TABLE}
      SET holder_id = $3,
          leased_until = NOW() + INTERVAL '2 minutes',
          updated_at = NOW()
      WHERE source = $1
        AND connector_key = $2
    `, [ownerB.source, ownerB.connectorKey, ownerB.holderId]);
    const job = await threadStore.createToolJob({
      id: "10000000-0000-4000-8000-000000000005",
      threadId: "owned-state-thread",
      owner: ownerB,
      kind: "command",
      summary: "standalone audit",
    });
    expect(job.owner).toEqual(ownerB);
    await expect(threadStore.updateToolJob(job.id, {
      progress: {status: "running"},
    })).resolves.toMatchObject({progress: {status: "running"}});

    await pool.query(`
      UPDATE ${POSTGRES_CONNECTOR_LEASE_TABLE}
      SET holder_id = $3,
          leased_until = NOW() + INTERVAL '2 minutes',
          updated_at = NOW()
      WHERE source = $1
        AND connector_key = $2
    `, [ownerA.source, ownerA.connectorKey, ownerA.holderId]);

    await expect(threadStore.updateToolJob(job.id, {
      progress: {status: "stale"},
    })).rejects.toThrow("is no longer owned by this daemon");
    await expect(threadStore.markOrphanedToolJobsLost(ownerA, "daemon owner changed", 100)).resolves.toBe(1);
    await expect(threadStore.getToolJob(job.id)).resolves.toMatchObject({
      status: "lost",
      statusReason: "daemon owner changed",
    });
    await pool.query(`
      UPDATE ${POSTGRES_CONNECTOR_LEASE_TABLE}
      SET holder_id = $3,
          leased_until = NOW() + INTERVAL '2 minutes',
          updated_at = NOW()
      WHERE source = $1
        AND connector_key = $2
    `, [ownerB.source, ownerB.connectorKey, ownerB.holderId]);
  });

  liveIt("shares the daemon fence across unrelated exclusive thread work", async () => {
    const sessions = new PostgresSessionStore({pool});
    for (const suffix of ["a", "b"] as const) {
      await sessions.createSession({
        id: `exclusive-session-${suffix}`,
        agentKey: "panda",
        kind: "branch",
        currentThreadId: `exclusive-thread-${suffix}`,
      });
      await threadStore.createThread({
        id: `exclusive-thread-${suffix}`,
        sessionId: `exclusive-session-${suffix}`,
      });
    }

    const first = await pool.connect();
    const second = await pool.connect();
    const takeover = await pool.connect();
    try {
      await first.query("BEGIN");
      await threadStore.assertExclusiveAccessRecord("exclusive-thread-a", ownerB, first);

      await second.query("BEGIN");
      await second.query("SET LOCAL lock_timeout = '250ms'");
      await expect(
        threadStore.assertExclusiveAccessRecord("exclusive-thread-b", ownerB, second),
      ).resolves.toBeUndefined();

      await takeover.query("BEGIN");
      await takeover.query("SET LOCAL lock_timeout = '100ms'");
      await expect(takeover.query(`
        UPDATE ${POSTGRES_CONNECTOR_LEASE_TABLE}
        SET leased_until = NOW() + INTERVAL '2 minutes'
        WHERE source = $1
          AND connector_key = $2
      `, [ownerB.source, ownerB.connectorKey])).rejects.toMatchObject({code: "55P03"});
    } finally {
      await Promise.allSettled([
        first.query("ROLLBACK"),
        second.query("ROLLBACK"),
        takeover.query("ROLLBACK"),
      ]);
      first.release();
      second.release();
      takeover.release();
    }
  });
});
