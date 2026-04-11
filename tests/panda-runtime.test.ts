import {afterEach, describe, expect, it, vi} from "vitest";
import {createPandaRuntime} from "../src/app/runtime/create-runtime.js";

const runtimeMocks = vi.hoisted(() => {
  const poolInstances: Array<{
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }> = [];
  const client = {
    off: vi.fn(),
    on: vi.fn(),
    query: vi.fn(),
    release: vi.fn(),
  };
  class MockPool {
    query = vi.fn();
    connect = vi.fn(async () => client);
    end = vi.fn(async () => {});

    constructor(_options: unknown) {
      poolInstances.push(this);
    }
  }

  return {
    client,
    ensureReadonlyChatQuerySchema: vi.fn(async () => {}),
    ensureSchema: vi.fn(async () => {}),
    MockPool,
    poolInstances,
    readDatabaseUsername: vi.fn(() => "readonly_user"),
  };
});

const browserMocks = vi.hoisted(() => {
  const instances: unknown[] = [];
  const start = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  class MockBrowserSessionService {
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
    MockBrowserSessionService,
    start,
  };
});

vi.mock("pg", () => ({
  Pool: runtimeMocks.MockPool,
}));

vi.mock("../src/domain/threads/runtime/index.js", () => ({
  PostgresThreadLeaseManager: class {},
  PostgresThreadRuntimeStore: class {
    identityStore = {};

    async ensureSchema(): Promise<void> {
      await runtimeMocks.ensureSchema();
    }

    async markRunningBashJobsLost(): Promise<number> {
      return 0;
    }
  },
  ThreadRuntimeCoordinator: class {},
}));

vi.mock("../src/domain/threads/runtime/postgres-readonly.js", () => ({
  ensureReadonlyChatQuerySchema: runtimeMocks.ensureReadonlyChatQuerySchema,
  readDatabaseUsername: runtimeMocks.readDatabaseUsername,
}));

vi.mock("../src/domain/threads/runtime/postgres.js", () => ({
  buildThreadRuntimeNotificationChannel: vi.fn(() => "thread_runtime_notifications"),
  parseThreadRuntimeNotification: vi.fn(() => null),
}));

vi.mock("../src/personas/panda/tools/postgres-readonly-query-tool.js", () => ({
  PostgresReadonlyQueryTool: class {},
}));

vi.mock("../src/personas/panda/tools/browser-service.js", () => ({
  BrowserSessionService: browserMocks.MockBrowserSessionService,
}));

describe("createPandaRuntime", () => {
  afterEach(() => {
    runtimeMocks.ensureSchema.mockReset();
    runtimeMocks.ensureReadonlyChatQuerySchema.mockReset();
    runtimeMocks.readDatabaseUsername.mockClear();
    runtimeMocks.client.on.mockClear();
    runtimeMocks.client.off.mockClear();
    runtimeMocks.client.query.mockReset();
    runtimeMocks.client.release.mockClear();
    runtimeMocks.poolInstances.length = 0;
    browserMocks.start.mockClear();
    browserMocks.close.mockClear();
    browserMocks.instances.length = 0;
  });

  it("ends the pool when schema bootstrap fails", async () => {
    runtimeMocks.ensureSchema.mockRejectedValueOnce(new Error("schema blew up"));

    await expect(createPandaRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    })).rejects.toThrow("schema blew up");

    expect(runtimeMocks.poolInstances).toHaveLength(1);
    expect(runtimeMocks.poolInstances[0]?.end).toHaveBeenCalledTimes(1);
  });

  it("releases the notification client and pool when LISTEN setup fails", async () => {
    runtimeMocks.client.query.mockRejectedValueOnce(new Error("listen blew up"));

    await expect(createPandaRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      onStoreNotification: vi.fn(),
      resolveDefinition: vi.fn(),
    })).rejects.toThrow("listen blew up");

    expect(runtimeMocks.client.off).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.client.release).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.poolInstances).toHaveLength(1);
    expect(runtimeMocks.poolInstances[0]?.end).toHaveBeenCalledTimes(1);
  });

  it("does not eagerly start the browser service during runtime bootstrap", async () => {
    const runtime = await createPandaRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    });

    expect(browserMocks.instances).toHaveLength(1);
    expect(browserMocks.start).not.toHaveBeenCalled();

    await runtime.close();

    expect(browserMocks.close).toHaveBeenCalledTimes(1);
  });
});
