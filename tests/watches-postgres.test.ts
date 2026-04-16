import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";
import {PostgresWatchStore} from "../src/domain/watches/index.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

function createPool() {
  const db = newDb();
  db.public.registerFunction({
    name: "pg_notify",
    args: [DataType.text, DataType.text],
    returns: DataType.text,
    implementation: () => "",
  });
  const adapter = db.adapters.createPg();
  return new adapter.Pool();
}

function createHttpJsonSource() {
  return {
    kind: "http_json",
    url: "https://example.com/btc",
    result: {
      observation: "scalar",
      valuePath: "price",
      label: "BTC",
    },
  } as const;
}

describe("PostgresWatchStore", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }

      await pool.end();
    }
  });

  it("creates, updates, and disables watches", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore} = await createRuntimeStores(pool);
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await sessionStore.createSession({
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "session-thread",
      createdByIdentityId: alice.id,
    });

    const watches = new PostgresWatchStore({pool});
    await watches.ensureSchema();

    const created = await watches.createWatch({
      sessionId: "session-main",
      createdByIdentityId: alice.id,
      title: "BTC 10% move",
      intervalMinutes: 5,
      source: createHttpJsonSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    });

    expect(created).toMatchObject({
      sessionId: "session-main",
      createdByIdentityId: "alice-id",
      enabled: true,
      title: "BTC 10% move",
    });
    expect(created.nextPollAt).toBeDefined();

    const updated = await watches.updateWatch({
      watchId: created.id,
      sessionId: "session-main",
      title: "BTC 12% move",
      intervalMinutes: 10,
      enabled: false,
    });

    expect(updated).toMatchObject({
      id: created.id,
      title: "BTC 12% move",
      intervalMinutes: 10,
      enabled: false,
    });

    const disabled = await watches.disableWatch({
      watchId: created.id,
      sessionId: "session-main",
      reason: "finished",
    });

    expect(disabled.enabled).toBe(false);
    expect(disabled.disabledAt).toBeDefined();
    expect(disabled.nextPollAt).toBeUndefined();
    expect(disabled.lastError).toBe("finished");
  });

  it("claims watches, persists run state, and de-duplicates events", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore} = await createRuntimeStores(pool);
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await sessionStore.createSession({
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "session-thread",
      createdByIdentityId: alice.id,
    });

    const watches = new PostgresWatchStore({pool});
    await watches.ensureSchema();

    const created = await watches.createWatch({
      sessionId: "session-main",
      createdByIdentityId: alice.id,
      title: "New registrations",
      intervalMinutes: 5,
      source: {
        kind: "sql_query",
        credentialEnvKey: "DATABASE_URL",
        dialect: "postgres",
        query: "select id, created_at from registrations order by created_at asc limit 50",
        result: {
          observation: "collection",
          itemIdField: "id",
          itemCursorField: "created_at",
        },
      },
      detector: {
        kind: "new_items",
      },
    });

    const claim = await watches.claimWatch({
      watchId: created.id,
      claimedBy: "watch-runner",
      claimExpiresAt: Date.now() + 60_000,
      nextPollAt: Date.now() + 5 * 60_000,
    });
    expect(claim).not.toBeNull();
    expect(claim?.run.status).toBe("claimed");

    const running = await watches.startWatchRun({
      runId: claim!.run.id,
      resolvedThreadId: "session-thread",
    });
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeDefined();

    const firstEvent = await watches.recordEvent({
      watchId: created.id,
      sessionId: "session-main",
      createdByIdentityId: alice.id,
      resolvedThreadId: "session-thread",
      eventKind: "new_items",
      summary: "Detected 2 new items.",
      dedupeKey: "same-event",
      payload: {
        totalNewItems: 2,
      },
    });
    const duplicateEvent = await watches.recordEvent({
      watchId: created.id,
      sessionId: "session-main",
      createdByIdentityId: alice.id,
      resolvedThreadId: "session-thread",
      eventKind: "new_items",
      summary: "Detected 2 new items.",
      dedupeKey: "same-event",
      payload: {
        totalNewItems: 2,
      },
    });

    expect(firstEvent.created).toBe(true);
    expect(duplicateEvent.created).toBe(false);
    expect(duplicateEvent.event.id).toBe(firstEvent.event.id);

    const completed = await watches.completeWatchRun({
      runId: claim!.run.id,
      status: "changed",
      resolvedThreadId: "session-thread",
      emittedEventId: firstEvent.event.id,
      state: {
        kind: "new_items",
        bootstrapped: true,
        lastCursor: "2026-04-11T10:00:00.000Z",
        lastIds: ["reg-2"],
      },
      lastError: null,
    });

    expect(completed.status).toBe("changed");
    expect(completed.emittedEventId).toBe(firstEvent.event.id);

    const latestRun = await watches.getLatestWatchRun(created.id);
    expect(latestRun?.status).toBe("changed");

    const reloaded = await watches.getWatch(created.id);
    expect(reloaded.state).toMatchObject({
      kind: "new_items",
      lastIds: ["reg-2"],
    });
    expect(reloaded.claimedAt).toBeUndefined();

    const eventRows = await pool.query(
      `SELECT COUNT(*)::INTEGER AS count FROM "runtime"."watch_events" WHERE watch_id = $1`,
      [created.id],
    );
    expect(eventRows.rows[0]).toMatchObject({
      count: 1,
    });
  });

  it("resets stored state when the source or detector changes", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore} = await createRuntimeStores(pool);
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await sessionStore.createSession({
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "session-thread",
      createdByIdentityId: alice.id,
    });

    const watches = new PostgresWatchStore({pool});
    await watches.ensureSchema();

    const created = await watches.createWatch({
      sessionId: "session-main",
      createdByIdentityId: alice.id,
      title: "BTC",
      intervalMinutes: 5,
      source: createHttpJsonSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    });

    const claim = await watches.claimWatch({
      watchId: created.id,
      claimedBy: "watch-runner",
      claimExpiresAt: Date.now() + 60_000,
      nextPollAt: Date.now() + 5 * 60_000,
    });
    expect(claim).not.toBeNull();

    await watches.completeWatchRun({
      runId: claim!.run.id,
      status: "no_change",
      state: {
        kind: "percent_change",
        baseline: 100,
        lastValue: 100,
      },
      lastError: null,
    });

    const updated = await watches.updateWatch({
      watchId: created.id,
      sessionId: "session-main",
      source: {
        kind: "http_json",
        url: "https://example.com/eth",
        result: {
          observation: "scalar",
          valuePath: "price",
          label: "ETH",
        },
      },
    });

    expect(updated.state).toBeUndefined();
    expect(updated.lastError).toBeUndefined();
    expect(updated.nextPollAt).toBeDefined();
  });

  it("reschedules the next poll from now when intervalMinutes changes", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore} = await createRuntimeStores(pool);
    const alice = await identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });
    await sessionStore.createSession({
      id: "session-main",
      agentKey: "panda",
      kind: "main",
      currentThreadId: "session-thread",
      createdByIdentityId: alice.id,
    });

    const watches = new PostgresWatchStore({pool});
    await watches.ensureSchema();

    const created = await watches.createWatch({
      sessionId: "session-main",
      createdByIdentityId: alice.id,
      title: "ISS",
      intervalMinutes: 5,
      source: {
        kind: "http_json",
        url: "https://example.com/iss",
        result: {
          observation: "snapshot",
          path: "iss_position",
        },
      },
      detector: {
        kind: "snapshot_changed",
      },
    });

    const claim = await watches.claimWatch({
      watchId: created.id,
      claimedBy: "watch-runner",
      claimExpiresAt: Date.now() + 60_000,
      nextPollAt: Date.now() + 5 * 60_000,
    });
    expect(claim).not.toBeNull();

    await watches.completeWatchRun({
      runId: claim!.run.id,
      status: "no_change",
      state: {
        kind: "snapshot_changed",
        fingerprint: "abc",
        excerpt: "before",
      },
      lastError: null,
    });

    const beforeUpdate = Date.now();
    const updated = await watches.updateWatch({
      watchId: created.id,
      sessionId: "session-main",
      intervalMinutes: 1,
    });
    const afterUpdate = Date.now();

    expect(updated.intervalMinutes).toBe(1);
    expect(updated.nextPollAt).toBeDefined();
    expect(updated.nextPollAt!).toBeGreaterThanOrEqual(beforeUpdate + 60_000 - 2_000);
    expect(updated.nextPollAt!).toBeLessThanOrEqual(afterUpdate + 60_000 + 2_000);
  });
});
