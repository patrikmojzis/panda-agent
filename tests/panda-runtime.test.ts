import {afterEach, describe, expect, it, vi} from "vitest";
import {createRuntime} from "../src/app/runtime/create-runtime.js";
import {bootstrapRuntime} from "../src/app/runtime/runtime-bootstrap.js";
import {createCommandCatalog, type CommandCatalogModule} from "../src/domain/commands/index.js";

const runtimeMocks = vi.hoisted(() => {
  const poolInstances: Array<{
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    query: ReturnType<typeof vi.fn>;
  }> = [];
  const poolOptions: unknown[] = [];
  const configurePool = vi.fn<(pool: MockPool) => void>();
  const coordinatorOptions: unknown[] = [];
  const coordinatorStop = vi.fn(async () => {});
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
      configurePool(this);
    }
  }

  return {
    client,
    configurePool,
    coordinatorOptions,
    coordinatorStop,
    MockPool,
    poolOptions,
    poolInstances,
    readonlyToolOptions,
    schemaAssertCurrent: vi.fn(async () => {}),
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

const providerRuntimeMocks = vi.hoisted(() => ({
  close: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: runtimeMocks.MockPool,
}));

vi.mock("../src/domain/threads/runtime/postgres.js", () => ({
  PostgresThreadRuntimeStore: class {
    identityStore = {};
  },
}));

vi.mock("../src/domain/subagents/postgres.js", () => ({
  PostgresSubagentProfileStore: class {
    async seedBuiltinProfiles(): Promise<never[]> {
      return [];
    }
  },
}));

vi.mock("../src/domain/threads/runtime/coordinator.js", () => ({
  ThreadRuntimeCoordinator: class {
    constructor(options: unknown) {
      runtimeMocks.coordinatorOptions.push(options);
    }
    async handleStoreNotification(): Promise<void> {}
    async handleStoreNotificationStatus(): Promise<void> {}
    async stop(): Promise<void> {
      await runtimeMocks.coordinatorStop();
    }
  },
}));

vi.mock("../src/integrations/postgres/schema-version.js", () => ({
  createPandaSchemaVerifier: vi.fn(() => ({
    assertCurrent: runtimeMocks.schemaAssertCurrent,
  })),
}));

vi.mock("../src/domain/threads/runtime/postgres-notifications.js", () => ({
  buildThreadRuntimeNotificationChannel: vi.fn(() => "runtime_events"),
  parseThreadRuntimeNotification: vi.fn(() => null),
}));

vi.mock("../src/integrations/postgres/readonly-query-command.js", () => ({
  postgresReadonlyQueryCommandDescriptor: {
    name: "postgres.readonly.query",
    summary: "Run a scoped readonly Postgres query.",
    description: "Run a scoped readonly Postgres query.",
    usage: "panda postgres readonly query --sql @query.sql",
    inputModes: ["flags", "json", "stdin", "file"],
    outputModes: ["json"],
    arguments: [],
    examples: [],
  },
  createPostgresReadonlyQueryCommand: vi.fn((options: unknown) => {
    runtimeMocks.readonlyToolOptions.push(options);
    return {
      descriptor: {
        name: "postgres.readonly.query",
        summary: "Run a scoped readonly Postgres query.",
        description: "Run a scoped readonly Postgres query.",
        usage: "panda postgres readonly query --sql @query.sql",
        inputModes: ["flags", "json", "stdin", "file"],
        outputModes: ["json"],
        arguments: [],
        examples: [],
      },
      execute: vi.fn(async () => ({
        ok: true,
        command: "postgres.readonly.query",
        output: {},
        summary: "ok",
      })),
    };
  }),
}));

vi.mock("../src/integrations/browser/client.js", () => ({
  BrowserRunnerClient: browserMocks.MockBrowserRunnerClient,
}));

vi.mock("../src/integrations/providers/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/integrations/providers/shared/runtime.js")>();
  return {
    ...actual,
    closePiAiRuntimeResources: providerRuntimeMocks.close,
  };
});

describe("createRuntime", () => {
  afterEach(() => {
    runtimeMocks.schemaAssertCurrent.mockReset();
    runtimeMocks.schemaAssertCurrent.mockResolvedValue(undefined);
    runtimeMocks.client.on.mockClear();
    runtimeMocks.client.off.mockClear();
    runtimeMocks.client.query.mockReset();
    runtimeMocks.client.query.mockImplementation(async () => ({rows: []}));
    runtimeMocks.client.release.mockReset();
    runtimeMocks.coordinatorOptions.length = 0;
    runtimeMocks.coordinatorStop.mockReset();
    runtimeMocks.coordinatorStop.mockResolvedValue(undefined);
    runtimeMocks.configurePool.mockReset();
    runtimeMocks.poolOptions.length = 0;
    runtimeMocks.poolInstances.length = 0;
    runtimeMocks.readonlyToolOptions.length = 0;
    browserMocks.start.mockClear();
    browserMocks.close.mockClear();
    browserMocks.instances.length = 0;
    providerRuntimeMocks.close.mockReset();
  });

  it.each([
    ...["panda/core", "panda/core-notify", "panda/core-trace"].flatMap((applicationName, index) =>
      ["postgres_pool_stats", "postgres_pool_ready"].map((event) => ({
        applicationName, event, allocated: index + 1, cleanupFails: false,
      }))
    ),
    {applicationName: "panda/core-trace", event: "postgres_pool_ready", allocated: 3, cleanupFails: true},
  ])("closes eager pools after $event fails for $applicationName (cleanup fails: $cleanupFails)", async ({applicationName, event, allocated, cleanupFails}) => {
    vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
    const failure = cleanupFails ? undefined : new Error("eager pool logging failed");
    runtimeMocks.configurePool.mockImplementation((pool) => {
      if (cleanupFails && runtimeMocks.poolInstances.length === 2) {
        pool.end.mockRejectedValueOnce(new Error("notification pool close failed"));
      }
    });
    const originalWrite = process.stdout.write.bind(process.stdout);
    const write = vi.spyOn(process.stdout, "write").mockImplementation((...args: Parameters<typeof process.stdout.write>) => {
      if (String(args[0]).includes(`"event":"${event}"`)
        && String(args[0]).includes(`"applicationName":"${applicationName}"`)) {
        throw failure;
      }
      return originalWrite(...args);
    });
    try {
      await expect(createRuntime({
        dbUrl: "postgres://panda:test@localhost:5432/panda",
        readOnlyDbUrl: "postgres://readonly:test@localhost:5432/panda",
        resolveDefinition: vi.fn(),
      })).rejects.toBe(failure);

      expect(runtimeMocks.poolInstances).toHaveLength(allocated);
      for (const pool of runtimeMocks.poolInstances) {
        expect(pool.off).toHaveBeenCalledTimes(1);
        expect(pool.end).toHaveBeenCalledTimes(1);
        expect(pool.off.mock.invocationCallOrder[0]).toBeLessThan(pool.end.mock.invocationCallOrder[0]!);
      }
      expect(vi.getTimerCount()).toBe(0);
      expect(runtimeMocks.schemaAssertCurrent).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("ends every pool when the schema revision check fails", async () => {
    runtimeMocks.schemaAssertCurrent.mockRejectedValueOnce(new Error("schema revision is stale"));

    await expect(createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    })).rejects.toThrow("schema revision is stale");

    expect(runtimeMocks.poolInstances).toHaveLength(3);
    expect(runtimeMocks.poolInstances.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("releases the notification client and pool when LISTEN setup fails", async () => {
    runtimeMocks.client.query.mockImplementation(async (sql: string) => {
      if (sql.trimStart().startsWith("LISTEN")) throw new Error("listen blew up");
      return {rows: []};
    });

    await expect(createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    })).rejects.toThrow("listen blew up");

    expect(runtimeMocks.client.off).toHaveBeenCalledTimes(3);
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

  it("shares core tool instances with subagents and appends browser in a stable order", async () => {
    const runtime = await createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    });

    try {
      expect(runtime.mainTools.map((tool) => tool.name)).toEqual([
        "bash",
        "background_job_status",
        "background_job_wait",
        "background_job_cancel",
        "view_media",
        "thinking_set",
      ]);
      expect(runtime.subagentTools.map((tool) => tool.name)).toEqual([
        ...runtime.mainTools.map((tool) => tool.name),
        "browser",
      ]);
      for (const [index, tool] of runtime.mainTools.entries()) {
        expect(runtime.subagentTools[index]).toBe(tool);
      }
    } finally {
      await runtime.close();
    }
  });

  it("closes provider transport caches after thread work drains", async () => {
    const closeOrder: string[] = [];
    runtimeMocks.coordinatorStop.mockImplementationOnce(async () => {
      closeOrder.push("coordinator");
    });
    providerRuntimeMocks.close.mockImplementationOnce(() => {
      closeOrder.push("provider-transports");
    });
    const runtime = await createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    });

    await runtime.close();

    expect(providerRuntimeMocks.close).toHaveBeenCalledTimes(1);
    expect(closeOrder).toEqual(["coordinator", "provider-transports"]);
  });

  it("drains the coordinator and closes every pool when listener shutdown fails", async () => {
    const runtime = await createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    });
    runtimeMocks.client.release.mockImplementationOnce(() => {
      throw new Error("listener release blew up");
    });

    await expect(runtime.close()).rejects.toThrow("listener release blew up");
    await expect(runtime.close()).rejects.toThrow("listener release blew up");

    expect(runtimeMocks.coordinatorStop).toHaveBeenCalledTimes(1);
    expect(runtimeMocks.poolInstances.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1, 1]);
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

  it.each(["observer", "ready log"])("closes a lazy pool when %s fails after bootstrap shutdown begins", async (failureStage) => {
    const runtime = await bootstrapRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      readOnlyDbUrl: "postgres://readonly:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    });
    const failure = new Error(`readonly ${failureStage} failed`);
    if (failureStage === "observer") {
      runtimeMocks.configurePool.mockImplementation((pool) => {
        pool.on.mockImplementationOnce(() => { throw failure; });
      });
    }
    const originalWrite = process.stdout.write.bind(process.stdout);
    const write = vi.spyOn(process.stdout, "write").mockImplementation((...args: Parameters<typeof process.stdout.write>) => {
      if (failureStage === "ready log"
        && String(args[0]).includes('"event":"postgres_pool_ready"')
        && String(args[0]).includes('"applicationName":"panda/core-ro"')) {
        throw failure;
      }
      return originalWrite(...args);
    });
    let closing: Promise<void> | undefined;
    try {
      const readonlyOptions = runtimeMocks.readonlyToolOptions.at(-1) as {getPool(): Promise<unknown>};
      const initializing = readonlyOptions.getPool();
      expect(runtimeMocks.poolInstances).toHaveLength(3);
      closing = runtime.close();
      await expect(initializing).rejects.toBe(failure);
      await closing;

      expect(runtimeMocks.poolInstances).toHaveLength(4);
      expect(runtimeMocks.poolInstances.map((pool) => pool.end.mock.calls.length)).toEqual([1, 1, 1, 1]);
      const readonlyPool = runtimeMocks.poolInstances[3]!;
      expect(readonlyPool.off).toHaveBeenCalledTimes(failureStage === "observer" ? 0 : 1);
      for (const pool of runtimeMocks.poolInstances.filter((pool) => pool !== readonlyPool || failureStage === "ready log")) {
        expect(pool.off).toHaveBeenCalledTimes(1);
        expect(pool.off.mock.invocationCallOrder[0]).toBeLessThan(pool.end.mock.invocationCallOrder[0]!);
      }
    } finally {
      write.mockRestore();
      await (closing ?? runtime.close());
    }
  });

  it("splits core query, notification, and bounded trace-writer pools", async () => {
    const runtime = await createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      resolveDefinition: vi.fn(),
    });

    expect(runtimeMocks.poolOptions).toEqual([
      expect.objectContaining({application_name: "panda/core", max: 4}),
      expect.objectContaining({application_name: "panda/core-notify", max: 4}),
      expect.objectContaining({
        application_name: "panda/core-trace",
        max: 1,
        statement_timeout: 5_000,
        query_timeout: 7_500,
      }),
    ]);
    expect(runtime.pool).toBe(runtimeMocks.poolInstances[0]);
    expect(runtime.notificationPool).toBe(runtimeMocks.poolInstances[1]);
    expect(runtimeMocks.coordinatorOptions.at(-1)).toEqual(expect.objectContaining({
      maxConcurrentRuns: 8,
      modelCallObserver: expect.any(Object),
    }));
    const publicTraceStore = runtime.modelCallTraces as unknown as {pool: unknown};
    const recorder = (runtimeMocks.coordinatorOptions.at(-1) as {modelCallObserver: unknown})
      .modelCallObserver as {close(): Promise<void>; sink: {pool: unknown}};
    expect(publicTraceStore.pool).toBe(runtimeMocks.poolInstances[0]);
    expect(recorder.sink.pool).toBe(runtimeMocks.poolInstances[2]);

    const closeOrder: string[] = [];
    const originalRecorderClose = recorder.close.bind(recorder);
    vi.spyOn(recorder, "close").mockImplementation(async () => {
      closeOrder.push("recorder");
      await originalRecorderClose();
    });
    runtimeMocks.poolInstances[2]!.end.mockImplementationOnce(async () => {
      closeOrder.push("trace-pool");
    });
    await runtime.close();
    expect(closeOrder).toEqual(["recorder", "trace-pool"]);
    const stopOrder = runtimeMocks.poolInstances.map((pool) => pool.off.mock.invocationCallOrder[0]!);
    const endOrder = runtimeMocks.poolInstances.map((pool) => pool.end.mock.invocationCallOrder[0]!);
    expect(stopOrder).toEqual([...stopOrder].sort((left, right) => left - right));
    expect(Math.max(...stopOrder)).toBeLessThan(Math.min(...endOrder));
    expect([endOrder[1], endOrder[2], endOrder[0]]).toEqual([...endOrder].sort((left, right) => left - right));
  });

  it("registers supplied command modules with the runtime dispatcher", async () => {
    const descriptor = {
      name: "custom.echo",
      summary: "Echo a custom message.",
      description: "Echo a custom message.",
      usage: "panda custom echo <message>",
      inputModes: ["flags", "json"],
      outputModes: ["json"],
      arguments: [],
      examples: [],
    } as const;
    const customModule: CommandCatalogModule = {
      descriptor,
      route: {
        helpArgv: ["custom", "echo"],
        jsonArgv: ["custom", "echo", "--json", "@payload.json"],
      },
      policy: {
        capability: "custom.echo",
        toolGroups: ["core"],
      },
      createCommand: () => ({
        descriptor,
        async execute(request) {
          return {
            ok: true,
            command: "custom.echo",
            output: request.input,
          };
        },
      }),
    };

    const commandCatalog = createCommandCatalog([customModule]);
    const runtime = await createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      commandCatalog,
      resolveDefinition: vi.fn(),
    });

    expect(runtime.commandCatalog).toBe(commandCatalog);
    expect(runtime.commandModules).toEqual([customModule]);
    await expect(runtime.commandExecutor.getCommand("custom.echo")).resolves.toEqual(descriptor);
    await expect(runtime.commandExecutor.listCommands()).resolves.toEqual([descriptor]);
    await expect(runtime.commandExecutor.listCommands({
      agentKey: "panda",
      sessionId: "session-main",
      allowedCommands: ["custom.echo"],
    })).resolves.toEqual([descriptor]);

    await runtime.close();
  });

  it("rejects mixed command catalog and command module options", async () => {
    const descriptor = {
      name: "custom.echo",
      summary: "Echo a custom message.",
      description: "Echo a custom message.",
      usage: "panda custom echo <message>",
      inputModes: ["flags", "json"],
      outputModes: ["json"],
      arguments: [],
      examples: [],
    } as const;
    const customModule: CommandCatalogModule = {
      descriptor,
      route: {
        helpArgv: ["custom", "echo"],
        jsonArgv: ["custom", "echo", "--json", "@payload.json"],
      },
      policy: {
        capability: "custom.echo",
      },
    };

    await expect(createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      commandCatalog: createCommandCatalog([customModule]),
      commandModules: [customModule],
      resolveDefinition: vi.fn(),
    })).rejects.toThrow("Pass either commandCatalog or commandModules, not both.");
  });

  it("rejects duplicate supplied command modules during bootstrap", async () => {
    const descriptor = {
      name: "custom.echo",
      summary: "Echo a custom message.",
      description: "Echo a custom message.",
      usage: "panda custom echo <message>",
      inputModes: ["flags", "json"],
      outputModes: ["json"],
      arguments: [],
      examples: [],
    } as const;
    const customModule: CommandCatalogModule = {
      descriptor,
      route: {
        helpArgv: ["custom", "echo"],
        jsonArgv: ["custom", "echo", "--json", "@payload.json"],
      },
      policy: {
        capability: "custom.echo",
      },
    };

    await expect(createRuntime({
      dbUrl: "postgres://panda:test@localhost:5432/panda",
      commandModules: [customModule, customModule],
      resolveDefinition: vi.fn(),
    })).rejects.toThrow("Duplicate Panda command module custom.echo.");
  });
});
