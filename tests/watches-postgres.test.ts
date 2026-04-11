import {afterEach, describe, expect, it} from "vitest";
import {DataType, newDb} from "pg-mem";

import {PostgresWatchStore} from "../src/domain/watches/index.js";
import {PostgresThreadRuntimeStore} from "../src/domain/threads/runtime/index.js";

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

    const threadStore = new PostgresThreadRuntimeStore({pool});
    await threadStore.ensureSchema();
    const alice = await threadStore.identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });

    const watches = new PostgresWatchStore({pool});
    await watches.ensureSchema();

    const created = await watches.createWatch({
      identityId: alice.id,
      agentKey: "panda",
      title: "BTC 10% move",
      intervalMinutes: 5,
      targetThreadId: "branch-thread",
      source: createHttpJsonSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    });

    expect(created).toMatchObject({
      identityId: "alice-id",
      agentKey: "panda",
      targetKind: "thread",
      targetThreadId: "branch-thread",
      enabled: true,
      title: "BTC 10% move",
    });
    expect(created.nextPollAt).toBeDefined();

    const updated = await watches.updateWatch({
      watchId: created.id,
      identityId: alice.id,
      agentKey: "panda",
      title: "BTC 12% move",
      intervalMinutes: 10,
      targetThreadId: null,
      enabled: false,
    });

    expect(updated).toMatchObject({
      id: created.id,
      title: "BTC 12% move",
      intervalMinutes: 10,
      targetKind: "home",
      targetThreadId: undefined,
      enabled: false,
    });

    const disabled = await watches.disableWatch({
      watchId: created.id,
      identityId: alice.id,
      agentKey: "panda",
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

    const threadStore = new PostgresThreadRuntimeStore({pool});
    await threadStore.ensureSchema();
    const alice = await threadStore.identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });

    const watches = new PostgresWatchStore({pool});
    await watches.ensureSchema();

    const created = await watches.createWatch({
      identityId: alice.id,
      agentKey: "panda",
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
      resolvedThreadId: "home-thread",
    });
    expect(running.status).toBe("running");
    expect(running.startedAt).toBeDefined();

    const firstEvent = await watches.recordEvent({
      watchId: created.id,
      identityId: alice.id,
      agentKey: "panda",
      resolvedThreadId: "home-thread",
      eventKind: "new_items",
      summary: "Detected 2 new items.",
      dedupeKey: "same-event",
      payload: {
        totalNewItems: 2,
      },
    });
    const duplicateEvent = await watches.recordEvent({
      watchId: created.id,
      identityId: alice.id,
      agentKey: "panda",
      resolvedThreadId: "home-thread",
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
      resolvedThreadId: "home-thread",
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
      `SELECT COUNT(*)::INTEGER AS count FROM "thread_runtime_watch_events" WHERE watch_id = $1`,
      [created.id],
    );
    expect(eventRows.rows[0]).toMatchObject({
      count: 1,
    });
  });

  it("resets stored state when the source or detector changes", async () => {
    const pool = createPool();
    pools.push(pool);

    const threadStore = new PostgresThreadRuntimeStore({pool});
    await threadStore.ensureSchema();
    const alice = await threadStore.identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });

    const watches = new PostgresWatchStore({pool});
    await watches.ensureSchema();

    const created = await watches.createWatch({
      identityId: alice.id,
      agentKey: "panda",
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
      identityId: alice.id,
      agentKey: "panda",
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

    const threadStore = new PostgresThreadRuntimeStore({pool});
    await threadStore.ensureSchema();
    const alice = await threadStore.identityStore.createIdentity({
      id: "alice-id",
      handle: "alice",
      displayName: "Alice",
    });

    const watches = new PostgresWatchStore({pool});
    await watches.ensureSchema();

    const created = await watches.createWatch({
      identityId: alice.id,
      agentKey: "panda",
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
      identityId: alice.id,
      agentKey: "panda",
      intervalMinutes: 1,
    });
    const afterUpdate = Date.now();

    expect(updated.intervalMinutes).toBe(1);
    expect(updated.nextPollAt).toBeDefined();
    expect(updated.nextPollAt!).toBeGreaterThanOrEqual(beforeUpdate + 60_000 - 2_000);
    expect(updated.nextPollAt!).toBeLessThanOrEqual(afterUpdate + 60_000 + 2_000);
  });
});
