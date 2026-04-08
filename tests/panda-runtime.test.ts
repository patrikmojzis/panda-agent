import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("pg", () => ({
  Pool: runtimeMocks.MockPool,
}));

vi.mock("../src/features/thread-runtime/index.js", () => ({
  PostgresThreadLeaseManager: class {},
  PostgresThreadRuntimeStore: class {
    identityStore = {};

    async ensureSchema(): Promise<void> {
      await runtimeMocks.ensureSchema();
    }
  },
  ThreadRuntimeCoordinator: class {},
}));

vi.mock("../src/features/thread-runtime/postgres-readonly.js", () => ({
  ensureReadonlyChatQuerySchema: runtimeMocks.ensureReadonlyChatQuerySchema,
  readDatabaseUsername: runtimeMocks.readDatabaseUsername,
}));

vi.mock("../src/features/thread-runtime/postgres.js", () => ({
  buildThreadRuntimeNotificationChannel: vi.fn(() => "thread_runtime_notifications"),
  parseThreadRuntimeNotification: vi.fn(() => null),
}));

vi.mock("../src/features/panda/tools/postgres-readonly-query-tool.js", () => ({
  PostgresReadonlyQueryTool: class {},
}));

import { createPandaRuntime } from "../src/features/panda/runtime.js";

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
});
