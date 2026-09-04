import {randomUUID} from "node:crypto";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {PANDA_SCHEMA_MIGRATIONS} from "../../src/app/database/migration-catalog.js";
import {createPostgresPool} from "../../src/app/runtime/database.js";
import {recreateSmokeDatabase} from "../../src/app/smoke/database.js";
import {PostgresAgentStore} from "../../src/domain/agents/postgres.js";
import {PostgresConnectorLeaseRepo} from "../../src/domain/connector-leases/repo.js";
import {PostgresSessionStore} from "../../src/domain/sessions/postgres.js";
import {PostgresSessionArchive} from "../../src/domain/sessions/archive.js";
import {resetSessionCurrentThread} from "../../src/domain/sessions/lifecycle.js";
import {PostgresThreadRuntimeStore} from "../../src/domain/threads/runtime/postgres.js";
import {enqueueSessionInputWithClient} from "../../src/domain/threads/runtime/postgres-inputs.js";
import {PostgresWatchStore} from "../../src/domain/watches/postgres.js";
import {evaluateWatchObservation} from "../../src/domain/watches/evaluator.js";
import type {WatchEvaluationResult} from "../../src/domain/watches/types.js";
import {createPostgresMigrator} from "../../src/lib/postgres-migrations.js";
import type {PgClientLike, PgPoolLike} from "../../src/lib/postgres-query.js";
import {withTransaction} from "../../src/lib/postgres-transaction.js";

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const liveIt = databaseUrl ? it : it.skip;
const changed: WatchEvaluationResult = {changed: true, nextState: {fingerprint: "B"},
  event: {eventKind: "snapshot_changed", summary: "B observed", dedupeKey: "content:B", payload: {text: "B"}}};
const heartbeatInput = {source: "heartbeat", message: {role: "user" as const, content: "Periodic tick", timestamp: 1}};

describe.sequential("watch and heartbeat acceptance with PostgreSQL", () => {
  let pool: ReturnType<typeof createPostgresPool>;
  let watches: PostgresWatchStore;
  let sessions: PostgresSessionStore;
  let threads: PostgresThreadRuntimeStore;
  let archives: PostgresSessionArchive;
  const owner = {source: "panda-core", connectorKey: "watch-test", holderId: randomUUID()};
  const legacyRunId = randomUUID();
  const legacyEventId = randomUUID();
  let legacyWatchId: string;

  beforeAll(async () => {
    if (!databaseUrl) return;
    const target = await recreateSmokeDatabase(databaseUrl);
    pool = createPostgresPool({connectionString: target.connectionString, applicationName: "panda/watch-acceptance-live-test", max: 8});
    const index = PANDA_SCHEMA_MIGRATIONS.findIndex(({id}) => id === "0022_watch_claim_ownership");
    if (index < 0) throw new Error("Watch ownership migration missing from catalog.");
    const migrate = (count: number) => createPostgresMigrator({pool, migrations: PANDA_SCHEMA_MIGRATIONS.slice(0, count),
      schemaName: "runtime", tableName: "schema_migrations", lockName: "panda:watch-acceptance-test"}).migrate();
    await migrate(index);
    await new PostgresAgentStore({pool}).bootstrapAgent({agentKey: "panda", displayName: "Panda"});
    watches = new PostgresWatchStore({pool});
    sessions = new PostgresSessionStore({pool});
    threads = new PostgresThreadRuntimeStore({pool});
    archives = new PostgresSessionArchive({pool, sessions, threads});
    const legacy = await fixture();
    legacyWatchId = legacy.watch.id;
    await pool.query(`UPDATE runtime.watches SET claimed_at = NOW(), claimed_by = 'old-label',
      claim_expires_at = NOW() + INTERVAL '1 hour', state = '{"fingerprint":"legacy"}' WHERE id = $1`, [legacyWatchId]);
    await pool.query(`INSERT INTO runtime.watch_runs (id, watch_id, session_id, scheduled_for, status)
      VALUES ($1, $2, $3, NOW(), 'running')`, [legacyRunId, legacyWatchId, legacy.sessionId]);
    await pool.query(`INSERT INTO runtime.watch_events (id, watch_id, session_id, event_kind, summary, dedupe_key)
      VALUES ($1, $2, $3, 'snapshot_changed', 'historical', 'content:legacy')`, [legacyEventId, legacyWatchId, legacy.sessionId]);
    await migrate(PANDA_SCHEMA_MIGRATIONS.length);
    await new PostgresConnectorLeaseRepo({pool}).tryAcquire({...owner, ttlMs: 600_000});
  });

  afterAll(async () => { await pool?.end(); });

  async function fixture() {
    const sessionId = randomUUID();
    const threadId = randomUUID();
    await sessions.createSession({id: sessionId, currentThreadId: threadId, agentKey: "panda", kind: "branch"});
    await threads.createThread({id: threadId, sessionId});
    const watch = await watches.createWatch({sessionId, title: "Snapshot", intervalMinutes: 1,
      source: {kind: "http_json", url: "https://example.com/snapshot", result: {observation: "snapshot"}},
      detector: {kind: "snapshot_changed"}, nextPollAt: Date.now() - 1000});
    return {sessionId, threadId, watch};
  }

  async function claim(watchId: string, ttl = 60_000) {
    const result = await watches.claimWatch({watchId, claimedBy: "same-worker-label", claimExpiresAt: Date.now() + ttl,
      nextPollAt: Date.now() + 60_000});
    expect(result).not.toBeNull();
    return result!;
  }

  async function counts(sessionId: string) {
    return (await pool.query(`SELECT
      (SELECT COUNT(*)::integer FROM runtime.inputs AS input JOIN runtime.threads AS thread ON thread.id = input.thread_id WHERE thread.session_id = $1) AS inputs,
      (SELECT COUNT(*)::integer FROM runtime.watch_events WHERE session_id = $1) AS events,
      (SELECT COUNT(*)::integer FROM runtime.session_runtime_config WHERE session_id = $1 AND pending_wake_at IS NOT NULL) AS wakes`, [sessionId])).rows[0];
  }

  function faultPool(options: {before?: string; loseCommit?: boolean}): PgPoolLike {
    let fired = false;
    return {query: (sql, values) => pool.query(sql, values ? [...values] : []), connect: async () => {
      const client = await pool.connect();
      return {release: () => client.release(), query: async (sql, values) => {
        if (!fired && options.before && sql.includes(options.before)) { fired = true; throw new Error("Injected write failure"); }
        const result = await client.query(sql, values ? [...values] : []);
        if (!fired && options.loseCommit && sql === "COMMIT") { fired = true; throw new Error("Lost COMMIT acknowledgement"); }
        return result;
      }};
    }};
  }

  function pinnedPool(client: PgClientLike): PgPoolLike {
    return {query: (sql, values) => client.query(sql, values),
      connect: async () => ({query: (sql, values) => client.query(sql, values), release() {}})};
  }

  async function reset(sessionId: string, previousThreadId: string) {
    const threadId = randomUUID();
    await resetSessionCurrentThread({pool, sessionStore: sessions, threadStore: threads, owner,
      previousThreadId, session: {sessionId, currentThreadId: threadId},
      thread: {id: threadId, sessionId, replacesThreadId: previousThreadId}});
    return threadId;
  }

  async function waitForBlockedOperation() {
    for (let i = 0; i < 200; i += 1) {
      const result = await pool.query(`SELECT COUNT(*)::integer AS count FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`);
      if (Number(result.rows[0]?.count) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Operation never waited for the held row lock.");
  }

  liveIt("retires legacy claims explicitly while preserving state, historical events, and silence", async () => {
    expect(await watches.getWatch(legacyWatchId)).toMatchObject({claimRunId: undefined, claimedBy: undefined,
      state: {fingerprint: "legacy"}, lastError: expect.stringContaining("ownership unavailable")});
    expect(await watches.getLatestWatchRun(legacyWatchId)).toMatchObject({id: legacyRunId, status: "failed", error: expect.stringContaining("not replayed")});
    expect((await pool.query(`SELECT id, dedupe_key FROM runtime.watch_events WHERE id = $1`, [legacyEventId])).rows)
      .toEqual([{id: legacyEventId, dedupe_key: "content:legacy"}]);
    expect((await counts((await watches.getWatch(legacyWatchId)).sessionId))).toEqual({events: 1, inputs: 0, wakes: 0});
  });

  liveIt("preserves a successor against stale start, renewal, failure and both acceptance outcomes", async () => {
    const f = await fixture();
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      const firstStore = new PostgresWatchStore({pool: pinnedPool(firstClient)});
      const secondStore = new PostgresWatchStore({pool: pinnedPool(secondClient)});
      const first = await firstStore.claimWatch({watchId: f.watch.id, claimedBy: "same-worker-label",
        claimExpiresAt: Date.now() + 60_000, nextPollAt: Date.now() + 60_000});
      expect(first).not.toBeNull();
      await firstStore.startWatchRun({runId: first!.run.id});
      await pool.query(`UPDATE runtime.watches SET claim_expires_at = NOW() - INTERVAL '1 second', next_poll_at = NOW() WHERE id = $1`, [f.watch.id]);
      const second = await secondStore.claimWatch({watchId: f.watch.id, claimedBy: "same-worker-label",
        claimExpiresAt: Date.now() + 60_000, nextPollAt: Date.now() + 60_000});
      expect(second?.watch.claimRunId).toBe(second?.run.id);
      expect(second?.run.id).not.toBe(first!.run.id);
      expect(await firstStore.startWatchRun({runId: first!.run.id})).toBeNull();
      expect(await firstStore.renewWatchClaim({runId: first!.run.id, claimTtlMs: 60_000})).toBe(false);
      await firstStore.failWatchRun({runId: first!.run.id, error: "stale failure"});
      expect(await firstStore.acceptWatchEvaluation({runId: first!.run.id, evaluation: changed})).toBeNull();
      expect(await firstStore.acceptWatchEvaluation({runId: first!.run.id, evaluation: {changed: false, nextState: {stale: true}}})).toBeNull();
      expect((await watches.getWatch(f.watch.id))).toMatchObject({claimRunId: second!.run.id, state: undefined, lastError: undefined});
      expect(await counts(f.sessionId)).toEqual({inputs: 0, events: 0, wakes: 0});
    } finally { firstClient.release(); secondClient.release(); }
  });

  liveIt("renews only a valid generation and keeps no-change acceptance silent", async () => {
    const f = await fixture();
    const c = await claim(f.watch.id);
    expect(await watches.renewWatchClaim({runId: c.run.id, claimTtlMs: 120_000})).toBe(true);
    expect((await watches.getWatch(f.watch.id)).claimExpiresAt).toBeGreaterThan(c.watch.claimExpiresAt!);
    const result = await watches.acceptWatchEvaluation({runId: c.run.id, evaluation: {changed: false, nextState: {baseline: "A"}}});
    expect(result?.status).toBe("no_change");
    expect(await counts(f.sessionId)).toEqual({inputs: 0, events: 0, wakes: 0});
    expect((await watches.getWatch(f.watch.id)).state).toEqual({baseline: "A"});
  });

  liveIt.each(["session", "thread"])("checks expiry after waiting on the %s lock", async (lock) => {
    const f = await fixture();
    const c = await claim(f.watch.id);
    const blocker = await pool.connect();
    let acceptance: ReturnType<typeof watches.acceptWatchEvaluation> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query(lock === "session" ? "SELECT id FROM runtime.agent_sessions WHERE id = $1 FOR UPDATE"
        : "SELECT id FROM runtime.threads WHERE id = $1 FOR UPDATE", [lock === "session" ? f.sessionId : f.threadId]);
      await pool.query(`UPDATE runtime.watches SET claim_expires_at = clock_timestamp() + INTERVAL '250 milliseconds' WHERE id = $1`, [f.watch.id]);
      acceptance = watches.acceptWatchEvaluation({runId: c.run.id, evaluation: changed});
      await waitForBlockedOperation();
      await blocker.query("SELECT pg_sleep(0.3)");
      await blocker.query("COMMIT");
      expect(await acceptance).toBeNull();
      expect(await counts(f.sessionId)).toEqual({inputs: 0, events: 0, wakes: 0});
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await acceptance; }
  });

  liveIt("rejects disabled and archived claims and does not resurrect them on restore", async () => {
    const disabled = await fixture();
    const d = await claim(disabled.watch.id);
    await pool.query(`UPDATE runtime.watches SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [disabled.watch.id]);
    await watches.disableWatch({watchId: disabled.watch.id, sessionId: disabled.sessionId});
    expect(await watches.acceptWatchEvaluation({runId: d.run.id, evaluation: changed})).toBeNull();
    expect(await watches.renewWatchClaim({runId: d.run.id, claimTtlMs: 60_000})).toBe(false);
    const f = await fixture();
    const c = await claim(f.watch.id);
    await archives.archive({sessionId: f.sessionId, expectedThreadId: f.threadId, owner});
    expect(await watches.acceptWatchEvaluation({runId: c.run.id, evaluation: changed})).toBeNull();
    await watches.updateWatch({watchId: f.watch.id, sessionId: f.sessionId, title: "Archived configuration remains editable"});
    await archives.restore({sessionId: f.sessionId, expectedThreadId: f.threadId, owner});
    expect(await watches.renewWatchClaim({runId: c.run.id, claimTtlMs: 60_000})).toBe(false);
    expect(await watches.acceptWatchEvaluation({runId: c.run.id, evaluation: changed})).toBeNull();
    expect(await counts(f.sessionId)).toEqual({inputs: 0, events: 0, wakes: 0});
  });

  liveIt("rolls event, input, wake, run and detector state back together", async () => {
    const f = await fixture();
    const c = await claim(f.watch.id);
    const broken = new PostgresWatchStore({pool: faultPool({before: "SET state = $2::jsonb"})});
    await expect(broken.acceptWatchEvaluation({runId: c.run.id, evaluation: changed})).rejects.toThrow("Injected write failure");
    expect(await counts(f.sessionId)).toEqual({inputs: 0, events: 0, wakes: 0});
    expect(await watches.getLatestWatchRun(f.watch.id)).toMatchObject({status: "claimed", emittedEventId: undefined});
    expect(await watches.getWatch(f.watch.id)).toMatchObject({claimRunId: c.run.id, state: undefined});
    expect((await watches.acceptWatchEvaluation({runId: c.run.id, evaluation: changed}))?.status).toBe("changed");
    expect(await counts(f.sessionId)).toEqual({inputs: 1, events: 1, wakes: 1});
  });

  liveIt("reads committed acceptance after a lost acknowledgement and reset without another wake", async () => {
    const f = await fixture();
    const c = await claim(f.watch.id);
    const broken = new PostgresWatchStore({pool: faultPool({loseCommit: true})});
    await expect(broken.acceptWatchEvaluation({runId: c.run.id, evaluation: changed})).rejects.toThrow("Lost COMMIT");
    const newThreadId = await reset(f.sessionId, f.threadId);
    const replay = await watches.acceptWatchEvaluation({runId: c.run.id, evaluation: changed});
    expect(replay).toMatchObject({status: "changed", emittedEventId: c.run.id, resolvedThreadId: f.threadId});
    expect(await counts(f.sessionId)).toEqual({inputs: 1, events: 1, wakes: 0});
    expect(await threads.hasPendingInputs(newThreadId)).toBe(false);
  });

  liveIt("uses the reset thread at admission and emits A→B→C→B as three distinct occurrences", async () => {
    const f = await fixture();
    const emitted: string[] = [];
    for (const text of ["A", "B", "C", "B"]) {
      await pool.query("UPDATE runtime.watches SET next_poll_at = NOW() WHERE id = $1", [f.watch.id]);
      const c = await claim(f.watch.id);
      const evaluation = evaluateWatchObservation(c.watch, {observation: {kind: "snapshot", text}});
      if (text === "B" && emitted.length === 0) await reset(f.sessionId, f.threadId);
      const result = await watches.acceptWatchEvaluation({runId: c.run.id, evaluation});
      if (result?.emittedEventId) emitted.push(result.emittedEventId);
    }
    expect(new Set(emitted).size).toBe(3);
    expect(await counts(f.sessionId)).toEqual({inputs: 3, events: 3, wakes: 1});
    const events = await pool.query("SELECT id, dedupe_key, resolved_thread_id FROM runtime.watch_events WHERE watch_id = $1", [f.watch.id]);
    for (const event of events.rows) {
      expect(event.dedupe_key).toBe(`run:${event.id}`);
      expect(event.resolved_thread_id).toBe((await sessions.getSession(f.sessionId)).currentThreadId);
    }
  });

  liveIt("resolves UUID and external-ID duplicates within the same open transaction, including reset tombstones", async () => {
    const f = await fixture();
    const inputId = randomUUID();
    const payload = {...heartbeatInput, source: "watch_event", externalMessageId: randomUUID()};
    await withTransaction(pool, async (client) => {
      expect((await enqueueSessionInputWithClient(client, f.sessionId, payload, "wake", {inputId})).disposition).toBe("inserted");
      expect((await enqueueSessionInputWithClient(client, f.sessionId, payload, "wake", {inputId})).disposition).toBe("duplicate_pending");
      expect((await enqueueSessionInputWithClient(client, f.sessionId, payload, "wake", {inputId: randomUUID()})).input.id).toBe(inputId);
      await client.query("SELECT 1");
    });
    await reset(f.sessionId, f.threadId);
    await withTransaction(pool, async (client) => {
      expect((await enqueueSessionInputWithClient(client, f.sessionId, payload, "wake", {inputId})).disposition).toBe("duplicate_discarded");
      await client.query("SELECT 1");
    });
    expect(await counts(f.sessionId)).toEqual({inputs: 1, events: 0, wakes: 0});
  });

  async function claimHeartbeat(sessionId: string) {
    await pool.query("UPDATE runtime.session_heartbeats SET enabled = TRUE, next_fire_at = NOW(), claim_expires_at = NULL WHERE session_id = $1", [sessionId]);
    const c = await sessions.claimHeartbeat({sessionId, claimedBy: randomUUID(), claimExpiresAt: Date.now() + 60_000});
    expect(c).not.toBeNull();
    return {sessionId, claimedBy: c!.claimedBy!, configRevision: c!.configRevision, attemptedAt: Date.now(),
      lastFireAt: Date.now(), input: heartbeatInput};
  }

  liveIt("fences heartbeat successors and handles no-input settlement without disturbing them", async () => {
    const f = await fixture();
    const firstClient = await pool.connect();
    const secondClient = await pool.connect();
    try {
      const firstStore = new PostgresSessionStore({pool: pinnedPool(firstClient)});
      const secondStore = new PostgresSessionStore({pool: pinnedPool(secondClient)});
      await pool.query("UPDATE runtime.session_heartbeats SET enabled = TRUE, next_fire_at = NOW() WHERE session_id = $1", [f.sessionId]);
      const a = await firstStore.claimHeartbeat({sessionId: f.sessionId, claimedBy: randomUUID(), claimExpiresAt: Date.now() + 60_000});
      expect(a).not.toBeNull();
      const result = {sessionId: f.sessionId, claimedBy: a!.claimedBy!, configRevision: a!.configRevision, attemptedAt: Date.now(), input: heartbeatInput};
      await pool.query("UPDATE runtime.session_heartbeats SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE session_id = $1", [f.sessionId]);
      const b = await secondStore.claimHeartbeat({sessionId: f.sessionId, claimedBy: randomUUID(), claimExpiresAt: Date.now() + 60_000});
      expect(b).not.toBeNull();
      expect(await firstStore.recordHeartbeatResult(result)).toBeNull();
      expect(await firstStore.recordHeartbeatResult({...result, input: undefined, lastSkipReason: "stale failure"})).toBeNull();
      expect((await sessions.getHeartbeat(f.sessionId))?.claimedBy).toBe(b!.claimedBy);
      expect(await counts(f.sessionId)).toEqual({inputs: 0, events: 0, wakes: 0});
    } finally { firstClient.release(); secondClient.release(); }
  });

  liveIt("atomically skips a heartbeat when real work arrived before acceptance", async () => {
    const f = await fixture();
    const c = await claimHeartbeat(f.sessionId);
    await threads.enqueueSessionInput(f.sessionId, {...heartbeatInput, source: "tui"}, "queue");
    expect(await sessions.recordHeartbeatResult(c)).toMatchObject({lastSkipReason: "busy", lastFireAt: undefined, claimedBy: undefined});
    expect(await counts(f.sessionId)).toEqual({inputs: 1, events: 0, wakes: 0});
  });

  liveIt("keeps heartbeat cadence edits while admitting and settling one tick", async () => {
    const f = await fixture();
    const c = await claimHeartbeat(f.sessionId);
    const cadence = await sessions.updateHeartbeatConfig({sessionId: f.sessionId, everyMinutes: 15, lastCadenceChangeReason: "Active investigation"});
    expect(await sessions.recordHeartbeatResult(c)).toMatchObject({nextFireAt: cadence.nextFireAt, configRevision: cadence.configRevision,
      lastFireAt: c.lastFireAt, claimedBy: undefined});
    expect(await counts(f.sessionId)).toEqual({inputs: 1, events: 0, wakes: 1});
  });

  liveIt("rolls heartbeat input back with settlement and reads its committed receipt after reset", async () => {
    const f = await fixture();
    const c = await claimHeartbeat(f.sessionId);
    const broken = new PostgresSessionStore({pool: faultPool({before: "SET next_fire_at = CASE"})});
    await expect(broken.recordHeartbeatResult(c)).rejects.toThrow("Injected write failure");
    expect(await counts(f.sessionId)).toEqual({inputs: 0, events: 0, wakes: 0});
    const lostCommit = new PostgresSessionStore({pool: faultPool({loseCommit: true})});
    await expect(lostCommit.recordHeartbeatResult(c)).rejects.toThrow("Lost COMMIT");
    await reset(f.sessionId, f.threadId);
    expect(await sessions.recordHeartbeatResult(c)).toMatchObject({claimedBy: undefined, lastFireAt: c.lastFireAt});
    expect(await counts(f.sessionId)).toEqual({inputs: 1, events: 0, wakes: 0});
  });

  liveIt("rejects heartbeat expiry after a thread lock wait and disabled/archive outcomes", async () => {
    const f = await fixture();
    const c = await claimHeartbeat(f.sessionId);
    const blocker = await pool.connect();
    let settlement: ReturnType<typeof sessions.recordHeartbeatResult> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT id FROM runtime.threads WHERE id = $1 FOR UPDATE", [f.threadId]);
      await pool.query("UPDATE runtime.session_heartbeats SET claim_expires_at = clock_timestamp() + INTERVAL '250 milliseconds' WHERE session_id = $1", [f.sessionId]);
      settlement = sessions.recordHeartbeatResult(c);
      await waitForBlockedOperation();
      await blocker.query("SELECT pg_sleep(0.3)");
      await blocker.query("COMMIT");
      expect(await settlement).toBeNull();
    } finally { await blocker.query("ROLLBACK"); blocker.release(); await settlement; }
    const disabled = await claimHeartbeat(f.sessionId);
    await sessions.updateHeartbeatConfig({sessionId: f.sessionId, enabled: false});
    expect(await sessions.recordHeartbeatResult(disabled)).toBeNull();
    const archived = await claimHeartbeat(f.sessionId);
    await archives.archive({sessionId: f.sessionId, expectedThreadId: f.threadId, owner});
    expect(await sessions.recordHeartbeatResult(archived)).toBeNull();
    await archives.restore({sessionId: f.sessionId, expectedThreadId: f.threadId, owner});
    expect(await sessions.recordHeartbeatResult(archived)).toBeNull();
    expect(await counts(f.sessionId)).toEqual({inputs: 0, events: 0, wakes: 0});
  });
});
