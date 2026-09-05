import {EventEmitter} from "node:events";

import {describe, expect, it, vi} from "vitest";

import {
  buildObservedPoolConfig,
  createPostgresPool,
  observePostgresPool,
} from "../src/lib/postgres-database.js";

interface FakeQueryResult {
  rows: Array<{ok: boolean}>;
}

type FakeQueryCallback = (error: Error | null, result?: FakeQueryResult) => void;
type FakeConnectCallback = (error: Error | null, client?: FakeClient, done?: () => void) => void;

interface FakeClient {
  query(text: string, values?: unknown[] | FakeQueryCallback, callback?: FakeQueryCallback): void;
  release(): void;
}

class FakePool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
  failure: Error | null = null;

  connect(callback?: FakeConnectCallback): Promise<FakeClient> | void {
    if (this.failure) {
      if (callback) {
        callback(this.failure);
        return;
      }
      return Promise.reject(this.failure);
    }

    const client: FakeClient = {
      query: (_text, values, maybeCallback) => {
        const resolvedCallback = typeof values === "function" ? values : maybeCallback;
        setImmediate(() => {
          resolvedCallback?.(null, {rows: [{ok: true}]});
        });
      },
      release: () => {},
    };

    if (callback) {
      setImmediate(() => {
        callback(null, client, () => {});
      });
      return;
    }

    return Promise.resolve(client);
  }

  query(text: string, values?: unknown[] | FakeQueryCallback, callback?: FakeQueryCallback): Promise<FakeQueryResult> | void {
    const resolvedCallback = typeof values === "function" ? values : callback;
    const resolvedValues = typeof values === "function" ? undefined : values;

    if (resolvedCallback) {
      this.connect((error, client) => {
        if (error) {
          resolvedCallback(error);
          return;
        }

        client!.query(text, resolvedValues, resolvedCallback);
      });
      return;
    }

    return new Promise<FakeQueryResult>((resolve, reject) => {
      this.connect((error, client) => {
        if (error) {
          reject(error);
          return;
        }

        client!.query(text, resolvedValues, (queryError, result) => {
          if (queryError) {
            reject(queryError);
            return;
          }

          resolve(result!);
        });
      });
    });
  }
}

class DuplicateQueryErrorPool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;

  connect(): Promise<FakeClient> {
    return Promise.resolve({
      query: () => {},
      release: () => {},
    });
  }

  query(): Promise<never> {
    const error = Object.assign(new Error('constraint "runtime_demo_fk" already exists'), {
      code: "42710",
      severity: "ERROR",
    });
    return Promise.reject(error);
  }
}

describe("observePostgresPool", () => {
  it("rolls back failed startup logging without changing the pool's behavior", async () => {
    vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
    const pool = new FakePool();
    const priorListener = vi.fn();
    pool.on("error", priorListener);
    const failure = new Error("startup log failed");
    const log = vi.fn((_event: string, payload: Record<string, unknown>) => {
      if (payload.reason === "startup") throw failure;
    });
    try {
      let thrown: unknown;
      try {
        observePostgresPool({pool, applicationName: "test-rollback", waitingLogIntervalMs: 100, log});
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
      expect(pool.listeners("error")).toEqual([priorListener]);

      log.mockClear();
      pool.waitingCount = 1;
      vi.advanceTimersByTime(100);
      pool.emit("error", failure);
      expect(priorListener).toHaveBeenCalledWith(failure);
      await expect(pool.connect()).resolves.toEqual(expect.objectContaining({release: expect.any(Function)}));
      await expect(pool.query("select 1")).resolves.toEqual({rows: [{ok: true}]});
      await expect(new Promise((resolve, reject) => {
        pool.query("select 1", (error, result) => error ? reject(error) : resolve(result));
      })).resolves.toEqual({rows: [{ok: true}]});

      pool.failure = new Error("later acquisition failure");
      await expect(pool.connect()).rejects.toBe(pool.failure);
      await expect(pool.query("select 1")).rejects.toBe(pool.failure);
      expect(log).not.toHaveBeenCalled();
    } finally {
      pool.removeAllListeners();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    {label: "Error", failure: new Error("startup failed")},
    {label: "string", failure: "startup failed"},
    {label: "null", failure: null},
    {label: "undefined", failure: undefined},
  ])("preserves the original $label startup failure when rollback also fails", ({failure}) => {
    vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
    const pool = new FakePool();
    const off = vi.spyOn(pool, "off").mockImplementation(() => { throw new Error("rollback failed"); });
    try {
      let thrown: unknown = Symbol("not thrown");
      try {
        observePostgresPool({pool, applicationName: "test-rollback", log: () => { throw failure; }});
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBe(failure);
      expect(off).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      off.mockRestore();
      pool.removeAllListeners();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("preserves the callback-style connect path used by pool.query", async () => {
    const pool = new FakePool();
    const log = vi.fn();
    const observer = observePostgresPool({
      pool,
      applicationName: "test",
      log,
    });

    await expect(Promise.race([
      pool.query("select 1"),
      new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("observed pool query timed out"));
        }, 50);
      }),
    ])).resolves.toEqual({rows: [{ok: true}]});

    observer.stop();
    expect(log).toHaveBeenCalledWith("postgres_pool_stats", expect.objectContaining({
      reason: "startup",
      applicationName: "test",
    }));
  });

  it("does not log duplicate-object bootstrap errors as pool failures", async () => {
    const pool = new DuplicateQueryErrorPool();
    const log = vi.fn();
    const observer = observePostgresPool({
      pool,
      applicationName: "test",
      log,
    });

    await expect(pool.query("alter table demo add constraint foo")).rejects.toMatchObject({
      code: "42710",
    });

    observer.stop();
    expect(log).not.toHaveBeenCalledWith("postgres_pool_error", expect.anything());
  });

  it("passes the acquire timeout into pg's native connection timeout", async () => {
    const pool = createPostgresPool({
      connectionString: "postgresql://panda:test@127.0.0.1:5432/panda",
      connectionTimeoutMillis: 1234,
    }) as import("pg").Pool & {
      options: {
        connectionTimeoutMillis?: number;
      };
    };

    try {
      expect(pool.options.connectionTimeoutMillis).toBe(1234);
    } finally {
      await pool.end();
    }
  });

  it("resolves the acquire timeout from env", () => {
    const previous = process.env.PANDA_DB_POOL_ACQUIRE_TIMEOUT_MS;
    process.env.PANDA_DB_POOL_ACQUIRE_TIMEOUT_MS = "4321";
    try {
      expect(buildObservedPoolConfig("test", "MISSING_MAX", 5).acquireTimeoutMillis).toBe(4321);
    } finally {
      if (previous === undefined) {
        delete process.env.PANDA_DB_POOL_ACQUIRE_TIMEOUT_MS;
      } else {
        process.env.PANDA_DB_POOL_ACQUIRE_TIMEOUT_MS = previous;
      }
    }
  });

  it("logs native pg acquire timeouts distinctly", async () => {
    class TimeoutConnectPool extends EventEmitter {
      totalCount = 1;
      idleCount = 0;
      waitingCount = 1;
      connect(): Promise<FakeClient> {
        return Promise.reject(new Error("timeout exceeded when trying to connect"));
      }
      query(): Promise<never> {
        return Promise.reject(new Error("not used"));
      }
    }

    const pool = new TimeoutConnectPool();
    const log = vi.fn();
    const observer = observePostgresPool({
      pool,
      applicationName: "test-timeout",
      log,
    });

    await expect(pool.connect()).rejects.toThrow("timeout exceeded");

    observer.stop();
    expect(log).toHaveBeenCalledWith("postgres_pool_error", expect.objectContaining({
      reason: "connect_timeout",
      applicationName: "test-timeout",
    }));
  });
});
