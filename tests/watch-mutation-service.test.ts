import {afterEach, describe, expect, it, vi} from "vitest";
import {DataType, newDb} from "pg-mem";

import {WatchMutationService} from "../src/domain/watches/mutation-service.js";
import type {WatchEvaluator} from "../src/domain/watches/runner.js";
import {PostgresWatchStore, type WatchRecord} from "../src/domain/watches/index.js";
import {evaluateWatch} from "../src/integrations/watches/evaluator.js";
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

function createPercentWatchSource(valuePath = "price") {
  return {
    kind: "http_json" as const,
    url: "https://example.com/btc",
    result: {
      observation: "scalar" as const,
      valuePath,
      label: "BTC",
    },
  };
}

function createPercentWatchState(baseline = 100) {
  return {
    kind: "percent_change",
    baseline,
    lastValue: baseline,
  } as const;
}

describe("WatchMutationService", () => {
  const pools: Array<{ end(): Promise<void> }> = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    while (pools.length > 0) {
      const pool = pools.pop();
      if (!pool) {
        continue;
      }
      await pool.end();
    }
  });

  async function createHarness(evaluateWatchFn?: WatchEvaluator) {
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

    const watchStore = new PostgresWatchStore({pool});
    await watchStore.ensureSchema();

    const evaluator = evaluateWatchFn ?? vi.fn<WatchEvaluator>().mockResolvedValue({
      changed: false,
      nextState: createPercentWatchState(),
    });
    const service = new WatchMutationService({
      store: watchStore,
      evaluateWatch: evaluator,
    });

    return {
      pool,
      alice,
      watchStore,
      service,
      evaluateWatch: evaluator,
      scope: {
        agentKey: "panda",
        sessionId: "session-main",
        createdByIdentityId: alice.id,
      },
    };
  }

  it("fails create fast for negative array indices without persisting", async () => {
    const harness = await createHarness();

    await expect(harness.service.createWatch({
      title: "Oura score",
      intervalMinutes: 5,
      source: createPercentWatchSource("data[-1].score"),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    }, harness.scope)).rejects.toThrow(
      'Negative array indices are not supported in source.result.valuePath "data[-1].score". Sort/filter upstream and use [0].',
    );

    expect(harness.evaluateWatch).not.toHaveBeenCalled();
    const watchRows = await harness.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."watches"`);
    expect(watchRows.rows[0]).toMatchObject({count: 0});
  });

  it("fails update fast for negative array indices without mutating the watch", async () => {
    const harness = await createHarness();
    const created = await harness.watchStore.createWatch({
      sessionId: harness.scope.sessionId,
      createdByIdentityId: harness.scope.createdByIdentityId,
      title: "BTC",
      intervalMinutes: 5,
      source: createPercentWatchSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    });

    await expect(harness.service.updateWatch({
      watchId: created.id,
      source: createPercentWatchSource("data[-1].score"),
    }, harness.scope)).rejects.toThrow(
      'Negative array indices are not supported in source.result.valuePath "data[-1].score". Sort/filter upstream and use [0].',
    );

    expect(harness.evaluateWatch).not.toHaveBeenCalled();
    const reloaded = await harness.watchStore.getWatch(created.id);
    expect(reloaded.source).toEqual(created.source);
  });

  it("fails create preflight without persisting a watch", async () => {
    const harness = await createHarness(vi.fn<WatchEvaluator>().mockRejectedValue(new Error("watch source unreachable")));

    await expect(harness.service.createWatch({
      title: "BTC",
      intervalMinutes: 5,
      source: createPercentWatchSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    }, harness.scope)).rejects.toThrow("watch source unreachable");

    const watchRows = await harness.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."watches"`);
    const runRows = await harness.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."watch_runs"`);
    const eventRows = await harness.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."watch_events"`);
    expect(watchRows.rows[0]).toMatchObject({count: 0});
    expect(runRows.rows[0]).toMatchObject({count: 0});
    expect(eventRows.rows[0]).toMatchObject({count: 0});
  });

  it("leaves an existing watch untouched when update preflight fails", async () => {
    const harness = await createHarness(vi.fn<WatchEvaluator>().mockRejectedValue(new Error("watch source unreachable")));
    const created = await harness.watchStore.createWatch({
      sessionId: harness.scope.sessionId,
      createdByIdentityId: harness.scope.createdByIdentityId,
      title: "BTC",
      intervalMinutes: 5,
      source: createPercentWatchSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
      state: createPercentWatchState(111),
    });

    await expect(harness.service.updateWatch({
      watchId: created.id,
      title: "BTC renamed",
    }, harness.scope)).rejects.toThrow("watch source unreachable");

    const reloaded = await harness.watchStore.getWatch(created.id);
    expect(reloaded.title).toBe("BTC");
    expect(reloaded.state).toMatchObject(createPercentWatchState(111));
  });

  it("seeds enabled watches on create and schedules the first poll from now plus interval", async () => {
    const evaluateWatchFn = vi.fn<WatchEvaluator>().mockResolvedValue({
      changed: false,
      nextState: createPercentWatchState(150),
    });
    const harness = await createHarness(evaluateWatchFn);
    const beforeCreate = Date.now();

    const created = await harness.service.createWatch({
      title: "BTC",
      intervalMinutes: 5,
      source: createPercentWatchSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
    }, harness.scope);

    const afterCreate = Date.now();
    expect(created.state).toMatchObject(createPercentWatchState(150));
    expect(created.nextPollAt).toBeDefined();
    expect(created.nextPollAt!).toBeGreaterThanOrEqual(beforeCreate + 5 * 60_000 - 2_000);
    expect(created.nextPollAt!).toBeLessThanOrEqual(afterCreate + 5 * 60_000 + 2_000);

    const runRows = await harness.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."watch_runs"`);
    const eventRows = await harness.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM "runtime"."watch_events"`);
    expect(runRows.rows[0]).toMatchObject({count: 0});
    expect(eventRows.rows[0]).toMatchObject({count: 0});
  });

  it("still preflights disabled creates but does not seed state", async () => {
    const evaluateWatchFn = vi.fn<WatchEvaluator>().mockResolvedValue({
      changed: false,
      nextState: createPercentWatchState(220),
    });
    const harness = await createHarness(evaluateWatchFn);

    const created = await harness.service.createWatch({
      title: "BTC",
      intervalMinutes: 5,
      source: createPercentWatchSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
      enabled: false,
    }, harness.scope);

    expect(evaluateWatchFn).toHaveBeenCalledTimes(1);
    expect(created.enabled).toBe(false);
    expect(created.state).toBeUndefined();
    expect(created.nextPollAt).toBeUndefined();
  });

  it("seeds fresh state on enabled source resets", async () => {
    const evaluateWatchFn = vi.fn<WatchEvaluator>().mockResolvedValue({
      changed: false,
      nextState: createPercentWatchState(200),
    });
    const harness = await createHarness(evaluateWatchFn);
    const created = await harness.watchStore.createWatch({
      sessionId: harness.scope.sessionId,
      createdByIdentityId: harness.scope.createdByIdentityId,
      title: "BTC",
      intervalMinutes: 5,
      source: createPercentWatchSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
      state: createPercentWatchState(100),
      nextPollAt: Date.now(),
    });
    const beforeUpdate = Date.now();

    const updated = await harness.service.updateWatch({
      watchId: created.id,
      source: {
        kind: "http_json",
        url: "https://example.com/eth",
        result: {
          observation: "scalar",
          valuePath: "price",
          label: "ETH",
        },
      },
    }, harness.scope);

    const afterUpdate = Date.now();
    expect(updated.state).toMatchObject(createPercentWatchState(200));
    expect(updated.nextPollAt).toBeDefined();
    expect(updated.nextPollAt!).toBeGreaterThanOrEqual(beforeUpdate + 5 * 60_000 - 2_000);
    expect(updated.nextPollAt!).toBeLessThanOrEqual(afterUpdate + 5 * 60_000 + 2_000);
  });

  it("preserves state on enable-only updates instead of reseeding", async () => {
    const evaluateWatchFn = vi.fn<WatchEvaluator>().mockResolvedValue({
      changed: false,
      nextState: createPercentWatchState(999),
    });
    const harness = await createHarness(evaluateWatchFn);
    const created = await harness.watchStore.createWatch({
      sessionId: harness.scope.sessionId,
      createdByIdentityId: harness.scope.createdByIdentityId,
      title: "BTC",
      intervalMinutes: 5,
      source: createPercentWatchSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
      enabled: false,
      state: createPercentWatchState(123),
      nextPollAt: null,
    });

    const updated = await harness.service.updateWatch({
      watchId: created.id,
      enabled: true,
    }, harness.scope);

    expect(updated.enabled).toBe(true);
    expect(updated.state).toMatchObject(createPercentWatchState(123));
    expect(updated.nextPollAt).toBeDefined();
  });

  it("clears seeded state and next poll on disabled source resets while still probing", async () => {
    const evaluateWatchFn = vi.fn<WatchEvaluator>().mockResolvedValue({
      changed: false,
      nextState: createPercentWatchState(300),
    });
    const harness = await createHarness(evaluateWatchFn);
    const created = await harness.watchStore.createWatch({
      sessionId: harness.scope.sessionId,
      createdByIdentityId: harness.scope.createdByIdentityId,
      title: "BTC",
      intervalMinutes: 5,
      source: createPercentWatchSource(),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
      state: createPercentWatchState(123),
      nextPollAt: Date.now(),
    });

    const updated = await harness.service.updateWatch({
      watchId: created.id,
      enabled: false,
      source: {
        kind: "http_json",
        url: "https://example.com/eth",
        result: {
          observation: "scalar",
          valuePath: "price",
          label: "ETH",
        },
      },
    }, harness.scope);

    expect(evaluateWatchFn).toHaveBeenCalledTimes(1);
    expect(updated.enabled).toBe(false);
    expect(updated.state).toBeUndefined();
    expect(updated.nextPollAt).toBeUndefined();
  });

  it("rejects negative indices for legacy watch records before any source resolver runs", async () => {
    const watch: WatchRecord = {
      id: "watch-legacy",
      sessionId: "session-main",
      title: "Legacy",
      intervalMinutes: 5,
      source: createPercentWatchSource("data[-1].score"),
      detector: {
        kind: "percent_change",
        percent: 10,
      },
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    };
    const resolver = vi.fn();

    await expect(evaluateWatch(watch, {
      credentialResolver: {
        resolveCredential: vi.fn(),
      } as any,
      sourceResolvers: {
        http_json: resolver,
      },
    })).rejects.toThrow(
      'Negative array indices are not supported in source.result.valuePath "data[-1].score". Sort/filter upstream and use [0].',
    );

    expect(resolver).not.toHaveBeenCalled();
  });
});
