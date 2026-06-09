import {afterEach, describe, expect, it, vi} from "vitest";
import {TELEGRAM_SOURCE} from "../src/integrations/channels/telegram/config.js";
import {
    telegramPairCommand,
    telegramUnpairCommand,
    telegramWhoamiCommand,
    telegramAccountSetCommand,
    telegramAccountImportEnvCommand,
    telegramAccountWhoamiCommand,
    telegramAccountDisableCommand,
    telegramRunCommand
} from "../src/integrations/channels/telegram/cli.js";

const telegramCliMocks = vi.hoisted(() => {
  const botInstances: MockBot[] = [];
  const storeInstances: MockPostgresIdentityStore[] = [];
  const agentStoreInstances: MockPostgresAgentStore[] = [];
  const connectorStoreInstances: MockPostgresConnectorAccountStore[] = [];
  const pool = {
    end: vi.fn(async () => {}),
  };
  let deleteIdentityBindingResult = true;
  let connectorAccountStatus = "enabled";
  let enabledAccountKeys = ["main"];
  const serviceConstructor = vi.fn();

  class MockBot {
    readonly api = {
      getMe: vi.fn(async () => ({
        id: 42,
          username: "panda_bot",
        first_name: "Panda Bot",
      })),
    };

    constructor(_token: string) {
      botInstances.push(this);
    }
  }

  class MockPostgresIdentityStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly ensureIdentity = vi.fn(async () => ({
      id: "identity-test-user",
    }));
    readonly getIdentityByHandle = vi.fn(async (handle: string) => {
      if (handle === "missing-user") {
        throw new Error("Unknown identity handle missing-user");
      }

      return {
        id: `identity-${handle}`,
      };
    });
    readonly ensureIdentityBinding = vi.fn(async (input: {
      source: string;
      connectorKey: string;
      externalActorId: string;
      identityId: string;
      metadata: { pairedVia: string };
    }) => ({
      id: "binding-1",
      ...input,
      createdAt: 1,
      updatedAt: 1,
    }));
    readonly deleteIdentityBinding = vi.fn(async (_lookup: {
      source: string;
      connectorKey: string;
      externalActorId: string;
    }) => deleteIdentityBindingResult);

    constructor(_options: unknown) {
      storeInstances.push(this);
    }
  }


  class MockPostgresAgentStore {
    readonly getAgent = vi.fn(async (agentKey: string) => ({
      agentKey,
    }));

    constructor(_options: unknown) {
      agentStoreInstances.push(this);
    }
  }

  class MockPostgresConnectorAccountStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly upsertAccount = vi.fn(async (input: {accountKey: string; connectorKey: string; displayName?: string; externalAccountId?: string; externalUsername?: string; ownerAgentKey?: string; status?: string}) => ({
      id: "connector-account-1",
      source: TELEGRAM_SOURCE,
      accountKey: input.accountKey,
      connectorKey: input.connectorKey,
      ownerKind: "system" as const,
      ownerIdentityId: null,
      ownerAgentKey: input.ownerAgentKey ?? null,
      displayName: input.displayName,
      externalAccountId: input.externalAccountId,
      externalUsername: input.externalUsername,
      status: input.status ?? "enabled",
      config: {},
      createdAt: 1,
      updatedAt: 2,
    }));
    readonly getAccountByKey = vi.fn(async (_source: string, accountKey: string) => ({
      id: "connector-account-1",
      source: TELEGRAM_SOURCE,
      accountKey,
      connectorKey: "42",
      ownerKind: "system" as const,
      ownerIdentityId: null,
      ownerAgentKey: null,
      displayName: "Panda Bot",
      externalAccountId: "42",
      externalUsername: "panda_bot",
      status: connectorAccountStatus,
      config: {},
      createdAt: 1,
      updatedAt: 2,
    }));
    readonly disableAccount = vi.fn(async (_source: string, accountKey: string) => ({
      id: "connector-account-1",
      source: TELEGRAM_SOURCE,
      accountKey,
      connectorKey: "42",
      ownerKind: "system" as const,
      ownerIdentityId: null,
      ownerAgentKey: null,
      status: "disabled" as const,
      config: {},
      createdAt: 1,
      updatedAt: 2,
    }));
    readonly setSecret = vi.fn(async () => ({accountId: "connector-account-1", secretKey: "bot_token", createdAt: 1, updatedAt: 2}));
    readonly getSecret = vi.fn(async () => "telegram-token");
    readonly listAccounts = vi.fn(async (filter?: {source?: string; status?: string}) => enabledAccountKeys.map((accountKey) => ({
      id: `connector-account-${accountKey}`,
      source: TELEGRAM_SOURCE,
      accountKey,
      connectorKey: "42",
      ownerKind: "system" as const,
      ownerIdentityId: null,
      ownerAgentKey: null,
      displayName: "Panda Bot",
      externalAccountId: "42",
      externalUsername: "panda_bot",
      status: filter?.status ?? connectorAccountStatus,
      config: {},
      createdAt: 1,
      updatedAt: 2,
    })));

    constructor(_options: unknown) {
      connectorStoreInstances.push(this);
    }
  }

  class MockTelegramService {
    constructor(_options: unknown) {
      serviceConstructor();
      throw new Error("TelegramService should not be constructed for this command.");
    }
  }

  return {
    MockBot,
    MockPostgresIdentityStore,
    MockPostgresAgentStore,
    MockPostgresConnectorAccountStore,
    MockTelegramService,
    botInstances,
    ensureSchemas: vi.fn(async (resources: Array<{ ensureSchema(): Promise<void> }>) => {
      for (const resource of resources) {
        await resource.ensureSchema();
      }
    }),
    storeInstances,
    agentStoreInstances,
    connectorStoreInstances,
    pool,
    serviceConstructor,
    setDeleteIdentityBindingResult: (result: boolean) => {
      deleteIdentityBindingResult = result;
    },
    setConnectorAccountStatus: (status: string) => {
      connectorAccountStatus = status;
    },
    setEnabledAccountKeys: (accountKeys: string[]) => {
      enabledAccountKeys = accountKeys;
    },
    withPostgresPool: vi.fn(async (_dbUrl: string | undefined, fn: (pool: typeof pool) => Promise<unknown>) => {
      try {
        return await fn(pool);
      } finally {
        await pool.end();
      }
    }),
  };
});

vi.mock("grammy", () => ({
  Bot: telegramCliMocks.MockBot,
}));

vi.mock("../src/integrations/channels/telegram/service.js", () => ({
  TelegramService: telegramCliMocks.MockTelegramService,
}));

vi.mock("../src/domain/identity/postgres.js", () => ({
  PostgresIdentityStore: telegramCliMocks.MockPostgresIdentityStore,
}));

vi.mock("../src/domain/agents/postgres.js", () => ({
  PostgresAgentStore: telegramCliMocks.MockPostgresAgentStore,
}));

vi.mock("../src/domain/connectors/postgres.js", () => ({
  PostgresConnectorAccountStore: telegramCliMocks.MockPostgresConnectorAccountStore,
}));

vi.mock("../src/lib/postgres-bootstrap.js", () => ({
  ensureSchemas: telegramCliMocks.ensureSchemas,
  withPostgresPool: telegramCliMocks.withPostgresPool,
}));

function latestBot(): InstanceType<typeof telegramCliMocks.MockBot> {
  const bot = telegramCliMocks.botInstances.at(-1);
  if (!bot) {
    throw new Error("Expected a mocked Telegram bot instance.");
  }

  return bot;
}

function latestStore(): InstanceType<typeof telegramCliMocks.MockPostgresIdentityStore> {
  const store = telegramCliMocks.storeInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked identity store instance.");
  }

  return store;
}

describe("Telegram CLI", () => {
  afterEach(() => {
    telegramCliMocks.botInstances.length = 0;
    telegramCliMocks.storeInstances.length = 0;
    telegramCliMocks.agentStoreInstances.length = 0;
    telegramCliMocks.connectorStoreInstances.length = 0;
    telegramCliMocks.pool.end.mockClear();
    telegramCliMocks.serviceConstructor.mockClear();
    telegramCliMocks.ensureSchemas.mockClear();
    telegramCliMocks.withPostgresPool.mockClear();
    telegramCliMocks.setDeleteIdentityBindingResult(true);
    telegramCliMocks.setConnectorAccountStatus("enabled");
    telegramCliMocks.setEnabledAccountKeys(["main"]);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads stored account bot identity for whoami", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramWhoamiCommand({account: "main", dbUrl: "postgres://telegram-db"});

    expect(telegramCliMocks.serviceConstructor).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      [
        "Telegram bot panda_bot",
        "id 42",
        "connector 42",
      ].join("\n") + "\n",
    );
  });

  it("requires an explicit stored account key for runtime Telegram commands", async () => {
    await expect(telegramWhoamiCommand()).rejects.toThrow("Telegram connector account key is required.");
    await expect(telegramPairCommand({
      identity: "alice",
      actor: "123",
      dbUrl: "postgres://telegram-db",
    })).rejects.toThrow("Telegram connector account key is required.");
    await expect(telegramUnpairCommand({
      actor: "123",
      dbUrl: "postgres://telegram-db",
    })).rejects.toThrow("Telegram connector account key is required.");
    await expect(telegramRunCommand(undefined, {dbUrl: "postgres://telegram-db"})).rejects.toThrow("Pass a Telegram account key or --all-enabled.");
    expect(telegramCliMocks.storeInstances).toHaveLength(0);
    expect(telegramCliMocks.serviceConstructor).not.toHaveBeenCalled();
  });

  it("pairs directly through the identity store without booting the runtime", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramPairCommand({
      account: "main",
      identity: "alice",
      actor: "123",
      dbUrl: "postgres://telegram-db",
    });

    const store = latestStore();
    expect(telegramCliMocks.serviceConstructor).not.toHaveBeenCalled();
    expect(telegramCliMocks.withPostgresPool).toHaveBeenCalledWith(
      "postgres://telegram-db",
      expect.any(Function),
    );
    expect(store.ensureSchema).toHaveBeenCalledTimes(1);
    expect(store.ensureIdentity).not.toHaveBeenCalled();
    expect(store.getIdentityByHandle).toHaveBeenCalledWith("alice");
    expect(store.ensureIdentityBinding).toHaveBeenCalledWith({
      source: TELEGRAM_SOURCE,
      connectorKey: "42",
      externalActorId: "123",
      identityId: "identity-alice",
      metadata: {
        pairedVia: "telegram-cli",
      },
    });
    expect(telegramCliMocks.pool.end).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(
      [
        "Paired Telegram actor 123.",
        "identity identity-alice",
        "connector 42",
      ].join("\n") + "\n",
    );
  });

  it("fails cleanly when the requested identity does not exist", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");

    await expect(telegramPairCommand({
      account: "main",
      identity: "missing-user",
      actor: "123",
      dbUrl: "postgres://telegram-db",
    })).rejects.toThrow("Unknown identity handle missing-user");

    expect(latestStore().ensureIdentityBinding).not.toHaveBeenCalled();
  });


  it("fails pair and unpair closed for non-enabled stored Telegram accounts", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    telegramCliMocks.setConnectorAccountStatus("disabled");

    await expect(telegramPairCommand({
      account: "main",
      identity: "alice",
      actor: "123",
      dbUrl: "postgres://telegram-db",
    })).rejects.toThrow("Telegram account main is not enabled.");
    expect(telegramCliMocks.storeInstances).toHaveLength(0);

    await expect(telegramUnpairCommand({
      account: "main",
      actor: "123",
      dbUrl: "postgres://telegram-db",
    })).rejects.toThrow("Telegram account main is not enabled.");
    expect(telegramCliMocks.storeInstances).toHaveLength(0);
  });

  it("unpairs directly through the identity store without booting the runtime", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramUnpairCommand({
      account: "main",
      actor: "123",
      dbUrl: "postgres://telegram-db",
    });

    const store = latestStore();
    expect(telegramCliMocks.serviceConstructor).not.toHaveBeenCalled();
    expect(store.deleteIdentityBinding).toHaveBeenCalledWith({
      source: TELEGRAM_SOURCE,
      connectorKey: "42",
      externalActorId: "123",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "Unpaired Telegram actor 123.",
        "connector 42",
      ].join("\n") + "\n",
    );
  });

  it("reports when a Telegram actor had no pairing", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    telegramCliMocks.setDeleteIdentityBindingResult(false);

    await telegramUnpairCommand({
      account: "main",
      actor: "123",
      dbUrl: "postgres://telegram-db",
    });

    expect(write).toHaveBeenCalledWith(
      [
        "No Telegram pairing found for actor 123.",
        "connector 42",
      ].join("\n") + "\n",
    );
  });

  it("stores a Telegram connector account without writing the raw token to output", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramAccountSetCommand("main", {botTokenStdin: true, replace: true, dbUrl: "postgres://telegram-db"}, {
      readBotTokenFromStdin: async () => "telegram-token",
    });

    const store = telegramCliMocks.connectorStoreInstances.at(-1)!;
    expect(store.ensureSchema).toHaveBeenCalledTimes(1);
    expect(store.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      source: TELEGRAM_SOURCE,
      accountKey: "main",
      connectorKey: "42",
      externalAccountId: "42",
      externalUsername: "panda_bot",
      status: "enabled",
    }));
    expect(store.setSecret).toHaveBeenCalledWith("connector-account-1", "bot_token", "telegram-token", expect.anything());
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Stored Telegram account main.");
    expect(output).not.toContain("telegram-token");
  });


  it("stores an agent-owned Telegram connector account for Control visibility", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramAccountSetCommand("main", {agent: "clawd", botTokenStdin: true, replace: true, dbUrl: "postgres://telegram-db"}, {
      readBotTokenFromStdin: async () => "telegram-token",
    });

    const agentStore = telegramCliMocks.agentStoreInstances.at(-1)!;
    const store = telegramCliMocks.connectorStoreInstances.at(-1)!;
    expect(agentStore.getAgent).toHaveBeenCalledWith("clawd");
    expect(store.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      ownerAgentKey: "clawd",
      source: TELEGRAM_SOURCE,
      accountKey: "main",
    }));
  });

  it("runs a stored Telegram account with the bot-id connector key", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    const run = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const createRunService = vi.fn(() => ({run, stop}));

    await telegramRunCommand("main", {dbUrl: "postgres://telegram-db"}, {createRunService});

    expect(createRunService).toHaveBeenCalledWith(expect.objectContaining({
      accountKey: "main",
      dbUrl: "postgres://telegram-db",
      expectedConnectorKey: "42",
      token: "telegram-token",
    }));
    expect(run).toHaveBeenCalledTimes(1);
  });



  it("runs all enabled Telegram accounts under a supervisor", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    telegramCliMocks.setEnabledAccountKeys(["main", "ops"]);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const services: Array<{accountKey?: string; start: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>}> = [];
    const createRunService = vi.fn((options: {accountKey?: string}) => {
      const service = {
        accountKey: options.accountKey,
        start: vi.fn(async () => {}),
        run: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
      services.push(service);
      return service;
    });

    await telegramRunCommand(undefined, {allEnabled: true, dbUrl: "postgres://telegram-db"}, {createRunService});

    expect(createRunService).toHaveBeenCalledTimes(2);
    expect(createRunService).toHaveBeenNthCalledWith(1, expect.objectContaining({
      accountKey: "main",
      disableHealthServer: true,
      poolMaxFallback: 2,
      expectedConnectorKey: "42",
    }));
    expect(createRunService).toHaveBeenNthCalledWith(2, expect.objectContaining({
      accountKey: "ops",
      disableHealthServer: true,
      poolMaxFallback: 2,
      expectedConnectorKey: "42",
    }));
    expect(services.map((service) => service.start.mock.calls.length)).toEqual([1, 1]);
    expect(services.map((service) => service.run.mock.calls.length)).toEqual([1, 1]);
    expect(write.mock.calls.map((call) => String(call[0])).join("\n")).toContain("worker_supervisor_started");
  });

  it("requires all-enabled mode or one Telegram account key for run", async () => {
    await expect(telegramRunCommand(undefined, {dbUrl: "postgres://telegram-db"})).rejects.toThrow("Pass a Telegram account key or --all-enabled.");
    await expect(telegramRunCommand("main", {allEnabled: true, dbUrl: "postgres://telegram-db"})).rejects.toThrow("Choose either a Telegram account key or --all-enabled, not both.");
  });

  it("fails helpfully when no Telegram accounts are enabled for all-enabled run", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    telegramCliMocks.setEnabledAccountKeys([]);

    await expect(telegramRunCommand(undefined, {allEnabled: true, dbUrl: "postgres://telegram-db"})).rejects.toThrow("No enabled Telegram accounts found");
  });

  it("isolates all-enabled startup failures and runs accounts that can start", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    telegramCliMocks.setEnabledAccountKeys(["broken", "main"]);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const createRunService = vi.fn((options: {accountKey?: string}) => ({
      start: vi.fn(async () => {
        if (options.accountKey === "broken") throw new Error("startup failed");
      }),
      run: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    }));

    await telegramRunCommand(undefined, {allEnabled: true, dbUrl: "postgres://telegram-db"}, {createRunService});

    const output = write.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("worker_start_failed");
    expect(output).toContain("worker_supervisor_started");
    expect(createRunService).toHaveBeenCalledTimes(2);
  });



  it("stops all-enabled Telegram workers on SIGTERM", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    telegramCliMocks.setEnabledAccountKeys(["main", "ops"]);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const services: Array<{start: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>}> = [];
    const createRunService = vi.fn(() => {
      const service = {
        start: vi.fn(async () => {}),
        run: vi.fn(() => new Promise<void>(() => {})),
        stop: vi.fn(async () => {}),
      };
      services.push(service);
      return service;
    });

    const commandPromise = telegramRunCommand(undefined, {allEnabled: true, dbUrl: "postgres://telegram-db"}, {createRunService});
    for (let attempt = 0; attempt < 20 && services.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    expect(services).toHaveLength(2);
    process.emit("SIGTERM", "SIGTERM");
    await commandPromise;

    expect(services.map((service) => service.stop.mock.calls.length)).toEqual([1, 1]);
  });

  it("fails all-enabled run when every enabled Telegram account fails startup", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    telegramCliMocks.setEnabledAccountKeys(["broken"]);
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const createRunService = vi.fn(() => ({
      start: vi.fn(async () => { throw new Error("startup failed"); }),
      run: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    }));

    await expect(telegramRunCommand(undefined, {allEnabled: true, dbUrl: "postgres://telegram-db"}, {createRunService})).rejects.toThrow("No Telegram workers started");
  });

  it("validates stored Telegram account whoami without exposing the stored token", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramAccountWhoamiCommand("main", {dbUrl: "postgres://telegram-db"});

    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Telegram account main.");
    expect(output).toContain("connector 42");
    expect(output).not.toContain("telegram-token");
  });


  it("imports a Telegram connector account token from env without exposing the raw token", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "telegram-cli-master-key");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramAccountImportEnvCommand("main", {envKey: "TELEGRAM_IMPORT_TOKEN", replace: true, dbUrl: "postgres://telegram-db"}, {
      env: {TELEGRAM_IMPORT_TOKEN: "telegram-token"} as NodeJS.ProcessEnv,
    });

    const store = telegramCliMocks.connectorStoreInstances.at(-1)!;
    expect(store.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      source: TELEGRAM_SOURCE,
      accountKey: "main",
      connectorKey: "42",
      status: "enabled",
    }));
    expect(store.setSecret).toHaveBeenCalledWith("connector-account-1", "bot_token", "telegram-token", expect.anything());
    const output = write.mock.calls.map((call) => String(call[0])).join("");
    expect(output).toContain("Imported Telegram account main.");
    expect(output).not.toContain("telegram-token");
  });

  it("disables a Telegram connector account", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramAccountDisableCommand("main", {dbUrl: "postgres://telegram-db"});

    const store = telegramCliMocks.connectorStoreInstances.at(-1)!;
    expect(store.disableAccount).toHaveBeenCalledWith(TELEGRAM_SOURCE, "main");
    expect(write).toHaveBeenCalledWith([
      "Disabled Telegram account main.",
      "status disabled",
      "connector 42",
    ].join("\n") + "\n");
  });

});
