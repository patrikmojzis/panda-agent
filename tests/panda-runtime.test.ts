import {afterEach, describe, expect, it, vi} from "vitest";
import {createRuntime} from "../src/app/runtime/create-runtime.js";

const runtimeMocks = vi.hoisted(() => {
  const poolInstances: Array<{
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }> = [];
  const poolOptions: unknown[] = [];
  const leaseManagerPools: unknown[] = [];
  const readonlyToolOptions: unknown[] = [];
  const client = {
    off: vi.fn(),
    on: vi.fn(),
    query: vi.fn(async () => ({rows: []})),
    release: vi.fn(),
  };
  class MockPool {
    totalCount = 0;
    idleCount = 0;
    waitingCount = 0;
    on = vi.fn();
    off = vi.fn();
    query = vi.fn(async () => ({rows: [{count: 0}]}));
    connect = vi.fn(async () => client);
    end = vi.fn(async () => {});

    constructor(options: unknown) {
      poolOptions.push(options);
      poolInstances.push(this);
    }
  }

  return {
    client,
    ensureReadonlySessionQuerySchema: vi.fn(async () => {}),
    ensureSchema: vi.fn(async () => {}),
    MockPool,
    leaseManagerPools,
    poolOptions,
    poolInstances,
    readonlyToolOptions,
    readDatabaseUsername: vi.fn(() => "readonly_user"),
  };
});

const browserMocks = vi.hoisted(() => {
  const instances: unknown[] = [];
  const start = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  class MockBrowserRunnerClient {
    constructor(_options: unknown) {
      instances.push(this);
    }

    async start(): Promise<void> {
      await start();
    }

    async close(): Promise<void> {
      await close();
    }
  }

  return {
    close,
    instances,
    MockBrowserRunnerClient,
    start,
  };
});

vi.mock("pg", () => ({
  Pool: runtimeMocks.MockPool,
}));

vi.mock("../src/domain/threads/runtime/index.js", () => ({
  PostgresThreadLeaseManager: class {
    constructor(pool: unknown) {
      runtimeMocks.leaseManagerPools.push(pool);
    }
  },
  PostgresThreadRuntimeStore: class {
    identityStore = {};

    async ensureSchema(): Promise<void> {
      await runtimeMocks.ensureSchema();
    }

    async markRunningToolJobsLost(): Promise<number> {
      return 0;
    }
  },
  ThreadRuntimeCoordinator: class {},
}));

vi.mock("../src/domain/threads/runtime/postgres-readonly.js", () => ({
  ensureReadonlySessionQuerySchema: runtimeMocks.ensureReadonlySessionQuerySchema,
  readDatabaseUsername: runtimeMocks.readDatabaseUsername,
}));

vi.mock("../src/domain/threads/runtime/postgres.js", () => ({
  buildThreadRuntimeNotificationChannel: vi.fn(() => "runtime_events"),
  parseThreadRuntimeNotification: vi.fn(() => null),
}));

vi.mock("../src/panda/tools/postgres-readonly-query-tool.js", () => ({
  PostgresReadonlyQueryTool: class {
    constructor(options: unknown) {
      runtimeMocks.readonlyToolOptions.push(options);
    }
  },
}));

vi.mock("../src/integrations/browser/client.js", () => ({
  BrowserRunnerClient: browserMocks.MockBrowserRunnerClient,
}));

describe("createRuntime", () => {
  afterEach(() => {
    runtimeMocks.ensureSchema.mockReset();
    runtimeMocks.ensureReadonlySessionQuerySchema.mockReset();
    runtimeMocks.readDatabaseUsername.mockClear();
    runtimeMocks.client.on.mockClear();
    runtimeMocks.client.off.mockClear();
    runtimeMocks.client.query.mockReset();
    runtimeMocks.client.query.mockImplementation(async () => ({rows: []}));
    runtimeMocks.client.release.mockClear();
    runtimeMocks.leaseManagerPools.length = 0;
    runtimeMocks.poolOptions.length = 0;
    runtimeMocks.poolInstances.length = 0;
    runtimeMocks.readonlyToolOptions.length = 0;
    browserMocks.start.mockClear();
    browserMocks.close.mockClear();
    browserMocks.instances.length = 0;
  });

  it("ends the pool when schema bootstrap fails", async () => {
    runtimeMocks.ensureSchema.mockRejectedValueOnce(new Error("schema blew up"));

    await expect(createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    })).rejects.toThrow("schema blew up");

    expect(runtimeMocks.poolInstances).toHaveLength(3);
    expect(runtimeMocks.poolInstances.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("releases the notification client and pool when LISTEN setup fails", async () => {
    runtimeMocks.client.query.mockRejectedValueOnce(new Error("listen blew up"));

    await expect(createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      onStoreNotification: vi.fn(),
      resolveDefinition: vi.fn(),
    })).rejects.toThrow("listen blew up");

    expect(runtimeMocks.client.off).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.client.release).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.poolInstances).toHaveLength(3);
    expect(runtimeMocks.poolInstances.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("does not eagerly start the browser service during runtime bootstrap", async () => {
    const runtime = await createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    });

    expect(browserMocks.instances).toHaveLength(1);
    expect(browserMocks.start).not.toHaveBeenCalled();

    await runtime.close();

    expect(browserMocks.close).toHaveBeenCalledTimes(1);
  });

  it("keeps the readonly pool lazy until the tool actually needs it", async () => {
    vi.stubEnv("READONLY_DATABASE_URL", "postgres://readonly:test@localhost:5432/panda");

    const runtime = await createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    });

    expect(runtimeMocks.poolInstances).toHaveLength(3);
    const readonlyOptions = runtimeMocks.readonlyToolOptions.at(-1) as {
      getPool?: () => Promise<unknown>;
    } | undefined;
    expect(typeof readonlyOptions?.getPool).toBe("function");

    await readonlyOptions?.getPool?.();

    expect(runtimeMocks.poolInstances).toHaveLength(4);

    await runtime.close();

    expect(runtimeMocks.poolInstances[0]?.end).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.poolInstances[1]?.end).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.poolInstances[2]?.end).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.poolInstances[3]?.end).toHaveBeenCalledTimes(1);
  });

  it("splits core query, notification, and thread lease pools", async () => {
    const runtime = await createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    });

    expect(runtimeMocks.poolOptions).toEqual([
      expect.objectContaining({application_name: "panda/core", max: 5}),
      expect.objectContaining({application_name: "panda/core-notify", max: 4}),
      expect.objectContaining({application_name: "panda/core-lease", max: 4}),
    ]);
    expect(runtime.pool).toBe(runtimeMocks.poolInstances[0]);
    expect(runtime.notificationPool).toBe(runtimeMocks.poolInstances[1]);
    expect(runtimeMocks.leaseManagerPools).toEqual([runtimeMocks.poolInstances[2]]);

    await runtime.close();
  });
});
