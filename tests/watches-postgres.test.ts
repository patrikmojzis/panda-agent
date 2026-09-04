import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";
import {PostgresWatchStore} from "../src/domain/watches/index.js";
import {ensurePostgresWatchSchema} from "../src/domain/watches/postgres-schema.js";
import {createRuntimeStores} from "./helpers/runtime-store-setup.js";

function createPool() {
  const db = newDb();
  db.public.registerFunction({name: "clock_timestamp", returns: DataType.timestamptz, impure: true, implementation: () => new Date()});
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

    const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);
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
    await threadStore.createThread({
      id: "session-thread",
      sessionId: "session-main",
    });

    const watches = new PostgresWatchStore({pool});
    await ensurePostgresWatchSchema(pool);

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
    expect(created.nextPollAt).toEqual(expect.any(Number));

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
    expect(disabled.disabledAt).toEqual(expect.any(Number));
    expect(disabled.nextPollAt).toBeUndefined();
    expect(disabled.lastError).toBe("finished");
  });

  it("claims watches and atomically persists no-change state", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);
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
    await threadStore.createThread({
      id: "session-thread",
      sessionId: "session-main",
    });

    const watches = new PostgresWatchStore({pool});
    await ensurePostgresWatchSchema(pool);

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
    expect(running.startedAt).toEqual(expect.any(Number));

    const completed = await watches.acceptWatchEvaluation({
      runId: claim!.run.id, evaluation: {changed: false, nextState: {kind: "new_items", lastIds: ["reg-2"]}},
    });
    expect(completed?.status).toBe("no_change");
    expect(await watches.acceptWatchEvaluation({runId: claim!.run.id, evaluation: {changed: false, nextState: {}}})).toEqual(completed);
    expect((await watches.getWatch(created.id)).state).toMatchObject({lastIds: ["reg-2"]});
    expect((await watches.getWatch(created.id)).claimRunId).toBeUndefined();
    expect(await watches.listWatchRuns({watchId: created.id, sessionId: "session-main"})).toHaveLength(1);
    expect((await pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."watch_events"`)).rows[0]).toMatchObject({count: 0});
  });

  it("rejects corrupted persisted watch states before returning records", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-0000-0000-000000000001",
          session_id: "session-main",
          created_by_identity_id: null,
          title: "Bad watch",
          interval_minutes: 5,
          source_config: {
            kind: "unsupported",
          },
          detector_config: {
            kind: "new_items",
          },
          enabled: true,
          next_poll_at: now,
          claimed_at: null,
          claimed_by: null,
          claim_expires_at: null,
          cooldown_until: null,
          last_error: null,
          state: null,
          disabled_at: null,
          created_at: now,
          updated_at: now,
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: "00000000-0000-0000-0000-000000000002",
          watch_id: "00000000-0000-0000-0000-000000000001",
          session_id: "session-main",
          created_by_identity_id: null,
          scheduled_for: now,
          status: "stuck",
          resolved_thread_id: null,
          emitted_event_id: null,
          error: null,
          created_at: now,
          started_at: null,
          finished_at: null,
        }],
      });
    const watches = new PostgresWatchStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(watches.getWatch("00000000-0000-0000-0000-000000000001")).rejects.toThrow(
      "Unsupported watch source kind unsupported.",
    );
    await expect(watches.getLatestWatchRun("00000000-0000-0000-0000-000000000001")).rejects.toThrow("Unsupported watch run status stuck.");
  });

  it("rejects malformed persisted watch intervals before returning records", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        id: "00000000-0000-0000-0000-000000000001",
        session_id: "session-main",
        created_by_identity_id: null,
        title: "Bad interval",
        interval_minutes: "5",
        source_config: {
          kind: "http_json",
          url: "https://example.com/btc",
          result: {
            observation: "scalar",
            valuePath: "price",
            label: "BTC",
          },
        },
        detector_config: {
          kind: "new_items",
        },
        enabled: true,
        next_poll_at: now,
        claimed_at: null,
        claimed_by: null,
        claim_expires_at: null,
        cooldown_until: null,
        last_error: null,
        state: null,
        disabled_at: null,
        created_at: now,
        updated_at: now,
      }],
    });
    const watches = new PostgresWatchStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(watches.getWatch("00000000-0000-0000-0000-000000000001")).rejects.toThrow(
      "Watch intervalMinutes must be a positive integer.",
    );
  });

  it("rejects incomplete persisted watch source configs before returning records", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        id: "00000000-0000-0000-0000-000000000001",
        session_id: "session-main",
        created_by_identity_id: null,
        title: "Bad source",
        interval_minutes: 5,
        source_config: {
          kind: "http_json",
          result: {
            observation: "scalar",
            valuePath: "price",
          },
        },
        detector_config: {
          kind: "new_items",
        },
        enabled: true,
        next_poll_at: now,
        claimed_at: null,
        claimed_by: null,
        claim_expires_at: null,
        cooldown_until: null,
        last_error: null,
        state: null,
        disabled_at: null,
        created_at: now,
        updated_at: now,
      }],
    });
    const watches = new PostgresWatchStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(watches.getWatch("00000000-0000-0000-0000-000000000001")).rejects.toThrow(
      "Watch HTTP JSON url must not be empty.",
    );
  });

  it("rejects incomplete persisted watch detector configs before returning records", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        id: "00000000-0000-0000-0000-000000000001",
        session_id: "session-main",
        created_by_identity_id: null,
        title: "Bad detector",
        interval_minutes: 5,
        source_config: createHttpJsonSource(),
        detector_config: {
          kind: "percent_change",
        },
        enabled: true,
        next_poll_at: now,
        claimed_at: null,
        claimed_by: null,
        claim_expires_at: null,
        cooldown_until: null,
        last_error: null,
        state: null,
        disabled_at: null,
        created_at: now,
        updated_at: now,
      }],
    });
    const watches = new PostgresWatchStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(watches.getWatch("00000000-0000-0000-0000-000000000001")).rejects.toThrow(
      "Watch percent change threshold must be a positive number.",
    );
  });

  it("rejects incomplete persisted MongoDB aggregate watch configs before returning records", async () => {
    const now = new Date("2026-05-01T12:00:00.000Z");
    const query = vi.fn().mockResolvedValueOnce({
      rows: [{
        id: "00000000-0000-0000-0000-000000000001",
        session_id: "session-main",
        created_by_identity_id: null,
        title: "Bad aggregate",
        interval_minutes: 5,
        source_config: {
          kind: "mongodb_query",
          credentialEnvKey: "MONGODB_URL",
          database: "sales",
          collection: "orders",
          operation: "aggregate",
          result: {
            observation: "scalar",
            valueField: "total",
          },
        },
        detector_config: {
          kind: "percent_change",
          percent: 10,
        },
        enabled: true,
        next_poll_at: now,
        claimed_at: null,
        claimed_by: null,
        claim_expires_at: null,
        cooldown_until: null,
        last_error: null,
        state: null,
        disabled_at: null,
        created_at: now,
        updated_at: now,
      }],
    });
    const watches = new PostgresWatchStore({
      pool: {
        query,
        connect: async () => {
          throw new Error("connect should not be used by row reads");
        },
      },
    });

    await expect(watches.getWatch("00000000-0000-0000-0000-000000000001")).rejects.toThrow(
      "Watch MongoDB pipeline must be JSON-serializable.",
    );
  });

  it("resets stored state when the source or detector changes", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);
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
    await threadStore.createThread({
      id: "session-thread",
      sessionId: "session-main",
    });

    const watches = new PostgresWatchStore({pool});
    await ensurePostgresWatchSchema(pool);

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

    await watches.acceptWatchEvaluation({
      runId: claim!.run.id,
      evaluation: {changed: false, nextState: {
        kind: "percent_change",
        baseline: 100,
        lastValue: 100,
      },
      },
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
    expect(updated.nextPollAt).toEqual(expect.any(Number));
  });

  it("reschedules the next poll from now when intervalMinutes changes", async () => {
    const pool = createPool();
    pools.push(pool);

    const {identityStore, sessionStore, threadStore} = await createRuntimeStores(pool);
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
    await threadStore.createThread({
      id: "session-thread",
      sessionId: "session-main",
    });

    const watches = new PostgresWatchStore({pool});
    await ensurePostgresWatchSchema(pool);

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

    await watches.acceptWatchEvaluation({
      runId: claim!.run.id,
      evaluation: {changed: false, nextState: {
        kind: "snapshot_changed",
        fingerprint: "abc",
        excerpt: "before",
      },
      },
    });

    const beforeUpdate = Date.now();
    const updated = await watches.updateWatch({
      watchId: created.id,
      sessionId: "session-main",
      intervalMinutes: 1,
    });
    const afterUpdate = Date.now();

    expect(updated.intervalMinutes).toBe(1);
    expect(updated.nextPollAt!).toBeGreaterThanOrEqual(beforeUpdate + 60_000 - 2_000);
    expect(updated.nextPollAt!).toBeLessThanOrEqual(afterUpdate + 60_000 + 2_000);
  });
});
