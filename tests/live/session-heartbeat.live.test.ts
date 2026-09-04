import {randomUUID} from "node:crypto";

import {afterAll, beforeAll, describe, expect, it} from "vitest";

import {createPandaSchemaMigrator} from "../../src/app/database/migration-catalog.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import type {SessionHeartbeatRecord} from "../../src/domain/sessions/types.js";
import {createPostgresPool} from "../../src/lib/postgres-database.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;

describe("session heartbeat concurrency with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let sessions: PostgresSessionStore;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({
      connectionString: target.connectionString,
      applicationName: "panda/session-heartbeat-live-test",
      max: 6,
    });
    await createPandaSchemaMigrator({pool, readonlyRole: null}).migrate();
    await new PostgresAgentStore({pool}).bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    sessions = new PostgresSessionStore({pool});
  });

  afterAll(async () => { await pool?.end(); });

  async function createDueHeartbeat(): Promise<SessionHeartbeatRecord> {
    const sessionId = randomUUID();
    await sessions.createSession({
      id: sessionId, agentKey: "panda", kind: "branch", currentThreadId: randomUUID(),
    });
    return sessions.updateHeartbeatConfig({
      sessionId, enabled: true, everyMinutes: 60, asOf: Date.now() - 3_601_000,
    });
  }

  async function claim(heartbeat: SessionHeartbeatRecord, token = randomUUID(), expiresAt = Date.now() + 300_000) {
    const claimed = await sessions.claimHeartbeat({
      sessionId: heartbeat.sessionId, claimedBy: token, claimExpiresAt: expiresAt,
    });
    if (!claimed) throw new Error("Expected the due heartbeat to be claimed.");
    return claimed;
  }

  async function waitForBlockedMutations(count: number): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await pool.query(`
        SELECT COUNT(*)::integer AS blocked
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND application_name = 'panda/session-heartbeat-live-test'
          AND wait_event_type = 'Lock'
      `);
      if (result.rows[0]?.blocked >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected ${count} heartbeat mutations to wait for the row lock.`);
  }

  liveIt("does not resurrect an operator disable committed while cadence mutation waits", async () => {
    const heartbeat = await createDueHeartbeat();
    const operator = await pool.connect();
    let mutation: Promise<SessionHeartbeatRecord> | undefined;
    try {
      await operator.query("BEGIN");
      await operator.query("UPDATE runtime.session_heartbeats SET enabled = FALSE WHERE session_id = $1", [heartbeat.sessionId]);
      mutation = sessions.updateHeartbeatConfig({
        sessionId: heartbeat.sessionId, everyMinutes: 15, lastCadenceChangeReason: "Review soon",
      });
      await waitForBlockedMutations(1);
      await operator.query("COMMIT");
      await expect(mutation).resolves.toMatchObject({enabled: false, everyMinutes: 15});
      await expect(sessions.getHeartbeat(heartbeat.sessionId)).resolves.toMatchObject({enabled: false, everyMinutes: 15});
    } finally {
      await operator.query("ROLLBACK");
      operator.release();
      await mutation?.catch(() => undefined);
    }
  });

  liveIt.each([
    {first: "completion", outcome: "fired"},
    {first: "change", outcome: "fired"},
    {first: "completion", outcome: "busy"},
    {first: "change", outcome: "busy"},
  ])("preserves accepted cadence when $first wins against $outcome completion", async ({first, outcome}) => {
    const heartbeat = await claim(await createDueHeartbeat());
    const attemptedAt = Date.now();
    const changedAt = attemptedAt + 1_000;
    const lock = await pool.connect();
    let change: Promise<SessionHeartbeatRecord> | undefined;
    let completion: Promise<SessionHeartbeatRecord | null> | undefined;
    const startChange = () => {
      change = sessions.updateHeartbeatConfig({
        sessionId: heartbeat.sessionId, everyMinutes: 15, asOf: changedAt,
        lastCadenceChangeReason: "The pace changed",
      });
    };
    const startCompletion = () => {
      completion = sessions.recordHeartbeatResult({
        sessionId: heartbeat.sessionId, claimedBy: heartbeat.claimedBy!,
        configRevision: heartbeat.configRevision, attemptedAt,
        ...(outcome === "busy" ? {lastSkipReason: "busy"} : {lastFireAt: attemptedAt}),
      });
    };
    try {
      await lock.query("BEGIN");
      await lock.query("SELECT session_id FROM runtime.session_heartbeats WHERE session_id = $1 FOR UPDATE", [heartbeat.sessionId]);
      (first === "change" ? startChange : startCompletion)();
      await waitForBlockedMutations(1);
      (first === "change" ? startCompletion : startChange)();
      await waitForBlockedMutations(2);
      await lock.query("COMMIT");
      const [accepted] = await Promise.all([change!, completion!]);
      await expect(sessions.getHeartbeat(heartbeat.sessionId)).resolves.toMatchObject({
        everyMinutes: 15, configRevision: heartbeat.configRevision + 1,
        nextFireAt: accepted.nextFireAt, claimedBy: undefined,
        lastCadenceChangeReason: "The pace changed",
        ...(outcome === "busy" ? {lastSkipReason: "busy", lastFireAt: undefined} : {lastFireAt: attemptedAt}),
      });
      expect(accepted.nextFireAt).toBe(changedAt + 15 * 60_000);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await Promise.allSettled([change, completion]);
    }
  });

  liveIt("preserves a changed schedule even when cadence returns to its claimed value", async () => {
    const heartbeat = await claim(await createDueHeartbeat());
    const attemptedAt = Date.now();
    await sessions.updateHeartbeatConfig({sessionId: heartbeat.sessionId, everyMinutes: 15});
    const accepted = await sessions.updateHeartbeatConfig({
      sessionId: heartbeat.sessionId, everyMinutes: 60, asOf: attemptedAt + 1_000,
    });
    await sessions.recordHeartbeatResult({
      sessionId: heartbeat.sessionId, claimedBy: heartbeat.claimedBy!,
      configRevision: heartbeat.configRevision, attemptedAt, lastFireAt: attemptedAt,
    });
    await expect(sessions.getHeartbeat(heartbeat.sessionId)).resolves.toMatchObject({
      everyMinutes: 60, configRevision: heartbeat.configRevision + 2,
      nextFireAt: accepted.nextFireAt, claimedBy: undefined,
    });
  });

  liveIt("fences expired and replaced claims without clearing the new owner", async () => {
    const heartbeat = await createDueHeartbeat();
    await expect(sessions.claimHeartbeat({
      sessionId: heartbeat.sessionId, claimedBy: "already-expired", claimExpiresAt: Date.now() - 1,
    })).resolves.toBeNull();
    const expired = await claim(heartbeat, "old-claim");
    await pool.query(`
      UPDATE runtime.session_heartbeats
      SET claim_expires_at = clock_timestamp() - INTERVAL '1 second'
      WHERE session_id = $1 AND claimed_by = $2
    `, [heartbeat.sessionId, expired.claimedBy]);
    const oldCompletion = {
      sessionId: heartbeat.sessionId, claimedBy: expired.claimedBy!,
      configRevision: expired.configRevision, attemptedAt: Date.now(), lastSkipReason: "stale",
    };
    await expect(sessions.recordHeartbeatResult(oldCompletion)).resolves.toBeNull();
    const current = await claim(heartbeat, "new-claim");
    await expect(sessions.recordHeartbeatResult(oldCompletion)).resolves.toBeNull();
    await expect(sessions.getHeartbeat(heartbeat.sessionId)).resolves.toMatchObject({
      claimedBy: current.claimedBy, nextFireAt: heartbeat.nextFireAt, lastSkipReason: undefined,
    });
  });

  liveIt("does not complete a revoked claim after disable and re-enable", async () => {
    const heartbeat = await claim(await createDueHeartbeat());
    await sessions.updateHeartbeatConfig({sessionId: heartbeat.sessionId, enabled: false});
    const enabled = await sessions.updateHeartbeatConfig({sessionId: heartbeat.sessionId, enabled: true});
    await expect(sessions.recordHeartbeatResult({
      sessionId: heartbeat.sessionId, claimedBy: heartbeat.claimedBy!,
      configRevision: heartbeat.configRevision, attemptedAt: Date.now(), lastFireAt: Date.now(),
    })).resolves.toBeNull();
    await expect(sessions.getHeartbeat(heartbeat.sessionId)).resolves.toEqual(enabled);
  });
});
