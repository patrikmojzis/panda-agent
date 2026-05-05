import {afterEach, describe, expect, it, vi} from "vitest";
import {TELEGRAM_SOURCE} from "../src/integrations/channels/telegram/config.js";
import {
    telegramPairCommand,
    telegramUnpairCommand,
    telegramWhoamiCommand
} from "../src/integrations/channels/telegram/cli.js";

const telegramCliMocks = vi.hoisted(() => {
  const botInstances: MockBot[] = [];
  const storeInstances: MockPostgresIdentityStore[] = [];
  const pool = {
    end: vi.fn(async () => {}),
  };
  let deleteIdentityBindingResult = true;
  const serviceConstructor = vi.fn();

  class MockBot {
    readonly api = {
      getMe: vi.fn(async () => ({
        id: 42,
        username: "panda_bot",
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

  class MockTelegramService {
    constructor(_options: unknown) {
      serviceConstructor();
      throw new Error("TelegramService should not be constructed for this command.");
    }
  }

  return {
    MockBot,
    MockPostgresIdentityStore,
    MockTelegramService,
    botInstances,
    ensureSchemas: vi.fn(async (resources: Array<{ ensureSchema(): Promise<void> }>) => {
      for (const resource of resources) {
        await resource.ensureSchema();
      }
    }),
    storeInstances,
    pool,
    serviceConstructor,
    setDeleteIdentityBindingResult: (result: boolean) => {
      deleteIdentityBindingResult = result;
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

vi.mock("../src/domain/identity/index.js", () => ({
  PostgresIdentityStore: telegramCliMocks.MockPostgresIdentityStore,
}));

vi.mock("../src/app/runtime/postgres-bootstrap.js", () => ({
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
    telegramCliMocks.pool.end.mockClear();
    telegramCliMocks.serviceConstructor.mockClear();
    telegramCliMocks.ensureSchemas.mockClear();
    telegramCliMocks.withPostgresPool.mockClear();
    telegramCliMocks.setDeleteIdentityBindingResult(true);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads bot identity directly for whoami", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramWhoamiCommand();

    expect(latestBot().api.getMe).toHaveBeenCalledTimes(1);
    expect(telegramCliMocks.serviceConstructor).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      [
        "Telegram bot panda_bot",
        "id 42",
        "connector 42",
      ].join("\n") + "\n",
    );
  });

  it("pairs directly through the identity store without booting the runtime", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramPairCommand({
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
    expect(telegramCliMocks.pool.end).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      [
        "Paired Telegram actor 123.",
        "identity identity-alice",
        "connector 42",
      ].join("\n") + "\n",
    );
  });

  it("fails cleanly when the requested identity does not exist", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");

    await expect(telegramPairCommand({
      identity: "missing-user",
      actor: "123",
      dbUrl: "postgres://telegram-db",
    })).rejects.toThrow("Unknown identity handle missing-user");

    expect(latestStore().ensureIdentityBinding).not.toHaveBeenCalled();
  });

  it("unpairs directly through the identity store without booting the runtime", async () => {
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await telegramUnpairCommand({
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
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    telegramCliMocks.setDeleteIdentityBindingResult(false);

    await telegramUnpairCommand({
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
});
