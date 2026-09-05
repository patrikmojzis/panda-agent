import {randomUUID} from "node:crypto";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {HmacScheduledCommandIntegrity} from "../../src/domain/scheduling/scheduled-commands/integrity.js";
import {PostgresScheduledCommandStore} from "../../src/domain/scheduling/scheduled-commands/postgres.js";
import {buildScheduledCommandTableNames} from "../../src/domain/scheduling/scheduled-commands/postgres-shared.js";
import {ScheduledCommandService} from "../../src/domain/scheduling/scheduled-commands/service.js";
import {ScheduledCommandVersionConflictError} from "../../src/domain/scheduling/scheduled-commands/store.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

describe("mechanical scheduled commands on PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let store: PostgresScheduledCommandStore;
  let service: ScheduledCommandService;
  const tables = buildScheduledCommandTableNames();

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/scheduled-commands-live-test",
      max: 16,
    });
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    const agents = new PostgresAgentStore({pool});
    const sessions = new PostgresSessionStore({pool});
    const threads = new PostgresThreadRuntimeStore({pool});
    await agents.bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    await sessions.createSession({
      id: "mechanical-session",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "mechanical-thread",
    });
    await threads.createThread({id: "mechanical-thread", sessionId: "mechanical-session"});

    store = new PostgresScheduledCommandStore({pool});
    service = new ScheduledCommandService({
      store,
      integrity: new HmacScheduledCommandIntegrity({
        currentKeyId: "test-v1",
        keys: new Map([["test-v1", Buffer.alloc(32, 9)]]),
      }),
      credentials: {resolveCredential: async () => null},
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  liveIt("fences occurrence concurrency and aggregates failure notifications through recovery", async () => {
    const command = await service.create({sessionId: "mechanical-session", agentKey: "panda"}, {
      title: "sync prices",
      command: "./scripts/sync.sh",
      cron: "* * * * *",
      timezone: "UTC",
    });
    const scheduledFor = Date.now() - 60_000;
    await pool.query(`UPDATE ${tables.scheduledCommands} SET next_fire_at = $2 WHERE id = $1`, [
      command.commandId,
      new Date(scheduledFor),
    ]);

    const materialized = (await Promise.all(Array.from({length: 12}, () => store.materializeScheduledRun({
      commandId: command.commandId,
      scheduledFor,
      nextFireAt: Date.now() + 60_000,
    })))).filter(Boolean);
    expect(materialized).toHaveLength(1);

    const claims = await Promise.all(Array.from({length: 12}, () => store.claimRun({
      claimedBy: "live-test",
      claimTtlMs: 60_000,
    })));
    const claim = claims.find(Boolean)!;
    expect(claims.filter(Boolean)).toHaveLength(1);
    await store.startRun({runId: claim.run.id, claimToken: claim.run.claimToken, environmentId: "runner:panda", cwd: "/workspace"});
    const firstFailure = await store.settleRun({
      runId: claim.run.id,
      claimToken: claim.run.claimToken,
      status: "failed",
      failureCode: "nonzero_exit",
      error: "exit 1",
    });
    expect(firstFailure).toMatchObject({status: "failed", notificationKind: "failure", claimToken: claim.run.claimToken});
    await store.completeNotification({runId: claim.run.id, claimToken: claim.run.claimToken});

    const repeated = await store.enqueueManualRun({commandId: command.commandId, sessionId: command.sessionId, expectedVersion: 1});
    const repeatedClaim = await store.claimRun({claimedBy: "live-test", claimTtlMs: 60_000});
    expect(repeatedClaim?.run.id).toBe(repeated.id);
    await store.startRun({runId: repeated.id, claimToken: repeatedClaim!.run.claimToken, environmentId: "runner:panda", cwd: "/workspace"});
    const repeatedFailure = await store.settleRun({
      runId: repeated.id,
      claimToken: repeatedClaim!.run.claimToken,
      status: "failed",
      failureCode: "nonzero_exit",
      error: "exit 1 again",
    });
    expect(repeatedFailure.notificationKind).toBeUndefined();
    expect(repeatedFailure.claimToken).toBeUndefined();

    const recovery = await store.enqueueManualRun({commandId: command.commandId, sessionId: command.sessionId, expectedVersion: 1});
    const recoveryClaim = await store.claimRun({claimedBy: "live-test", claimTtlMs: 60_000});
    expect(recoveryClaim?.run.id).toBe(recovery.id);
    await store.startRun({runId: recovery.id, claimToken: recoveryClaim!.run.claimToken, environmentId: "runner:panda", cwd: "/workspace"});
    const recovered = await store.settleRun({
      runId: recovery.id,
      claimToken: recoveryClaim!.run.claimToken,
      status: "succeeded",
      result: {
        resolvedEnvironmentId: "runner:panda",
        resolvedCwd: "/workspace",
        exitCode: 0,
        timedOut: false,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    });
    expect(recovered).toMatchObject({status: "succeeded", notificationKind: "recovery"});
    await store.completeNotification({runId: recovery.id, claimToken: recoveryClaim!.run.claimToken});
    await expect(store.getCommand(command.commandId)).resolves.toMatchObject({consecutiveFailures: 0});
  });

  liveIt("returns the locked current version when a write loses its optimistic race", async () => {
    const created = await service.create({sessionId: "mechanical-session", agentKey: "panda"}, {
      title: "racing command",
      command: "./scripts/v1.sh",
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: false,
    });
    const updated = await service.update({sessionId: created.sessionId, agentKey: "panda"}, created.commandId, {
      expectedVersion: 1,
      command: "./scripts/v2.sh",
    });

    await expect(store.replaceVersion({
      commandId: created.commandId,
      sessionId: created.sessionId,
      expectedVersion: 1,
      definition: {
        title: updated.title,
        command: updated.command,
        cron: updated.cron,
        timezone: updated.timezone,
        credentialNames: updated.credentialNames,
        timeoutMs: updated.timeoutMs,
        enabled: updated.enabled,
        keyId: updated.keyId,
        integrityTag: updated.integrityTag,
      },
    })).rejects.toBeInstanceOf(ScheduledCommandVersionConflictError);
  });

  liveIt("cancels a historical signed occurrence after its active pointer is rolled back", async () => {
    const created = await service.create({sessionId: "mechanical-session", agentKey: "panda"}, {
      title: "replayed command",
      command: "./scripts/v1.sh",
      cron: "0 * * * *",
      timezone: "UTC",
    });
    await service.update({sessionId: created.sessionId, agentKey: "panda"}, created.commandId, {
      expectedVersion: 1,
      command: "./scripts/v2.sh",
      enabled: false,
    });

    await pool.query(`UPDATE ${tables.scheduledCommands} SET active_version = 1 WHERE id = $1`, [created.commandId]);
    const replayRunId = randomUUID();
    await pool.query(`
      INSERT INTO ${tables.scheduledCommandRuns} (
        id, command_id, session_id, version, trigger, scheduled_for, status
      ) VALUES ($1, $2, $3, 1, 'schedule', NOW(), 'pending')
    `, [replayRunId, created.commandId, created.sessionId]);

    await expect(store.claimRun({claimedBy: "live-test", claimTtlMs: 60_000})).resolves.toBeNull();
    await expect(pool.query(`
      SELECT status, failure_code
      FROM ${tables.scheduledCommandRuns}
      WHERE id = $1
    `, [replayRunId])).resolves.toMatchObject({
      rows: [{status: "cancelled", failure_code: "superseded_version"}],
    });
  });

  liveIt("pins immutable versions and cascades every scheduler row with its session", async () => {
    const created = await service.create({sessionId: "mechanical-session", agentKey: "panda"}, {
      title: "versioned command",
      command: "./scripts/v1.sh",
      cron: "0 * * * *",
      timezone: "UTC",
      enabled: false,
    });
    const updated = await service.update({sessionId: created.sessionId, agentKey: "panda"}, created.commandId, {
      expectedVersion: 1,
      command: "./scripts/v2.sh",
    });
    expect(updated).toMatchObject({version: 2, command: "./scripts/v2.sh"});
    const versions = await pool.query(`SELECT version, command_text FROM ${tables.scheduledCommandVersions} WHERE command_id = $1 ORDER BY version`, [created.commandId]);
    expect(versions.rows).toEqual([
      {version: 1, command_text: "./scripts/v1.sh"},
      {version: 2, command_text: "./scripts/v2.sh"},
    ]);

    await pool.query(`DELETE FROM "runtime"."agent_sessions" WHERE id = 'mechanical-session'`);
    await expect(pool.query(`SELECT 1 FROM ${tables.scheduledCommands}`)).resolves.toMatchObject({rows: []});
    await expect(pool.query(`SELECT 1 FROM ${tables.scheduledCommandVersions}`)).resolves.toMatchObject({rows: []});
    await expect(pool.query(`SELECT 1 FROM ${tables.scheduledCommandRuns}`)).resolves.toMatchObject({rows: []});
  });
});
