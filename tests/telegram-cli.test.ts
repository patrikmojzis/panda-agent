import {afterEach, describe, expect, it, vi} from "vitest";
import {TELEGRAM_SOURCE} from "../src/integrations/channels/telegram/config.js";
import {telegramPairCommand, telegramWhoamiCommand} from "../src/integrations/channels/telegram/cli.js";

const telegramCliMocks = vi.hoisted(() => {
  const botInstances: MockBot[] = [];
  const storeInstances: MockPostgresIdentityStore[] = [];
  const pool = {
    end: vi.fn(async () => {}),
  };
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
      id: "identity-local",
    }));
    readonly getIdentityByHandle = vi.fn(async (handle: string) => ({
      id: `identity-${handle}`,
    }));
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
    storeInstances,
    pool,
    serviceConstructor,
    createPandaPool: vi.fn(() => pool),
    requirePandaDatabaseUrl: vi.fn((dbUrl?: string) => dbUrl ?? "postgres://resolved-db"),
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
  createDefaultIdentityInput: () => ({
    id: "local-id",
    handle: "local",
    displayName: "Local",
    status: "active",
  }),
}));

vi.mock("../src/app/runtime/create-runtime.js", () => ({
  createPandaPool: telegramCliMocks.createPandaPool,
  requirePandaDatabaseUrl: telegramCliMocks.requirePandaDatabaseUrl,
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
    telegramCliMocks.createPandaPool.mockClear();
    telegramCliMocks.requirePandaDatabaseUrl.mockClear();
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
      identity: "local",
      actor: "123",
      dbUrl: "postgres://telegram-db",
    });

    const store = latestStore();
    expect(telegramCliMocks.serviceConstructor).not.toHaveBeenCalled();
    expect(telegramCliMocks.requirePandaDatabaseUrl).toHaveBeenCalledWith("postgres://telegram-db");
    expect(telegramCliMocks.createPandaPool).toHaveBeenCalledWith("postgres://telegram-db");
    expect(store.ensureSchema).toHaveBeenCalledTimes(1);
    expect(store.ensureIdentity).toHaveBeenCalledTimes(1);
    expect(store.getIdentityByHandle).not.toHaveBeenCalled();
    expect(store.ensureIdentityBinding).toHaveBeenCalledWith({
      source: TELEGRAM_SOURCE,
      connectorKey: "42",
      externalActorId: "123",
      identityId: "identity-local",
      metadata: {
        pairedVia: "telegram-cli",
      },
    });
    expect(telegramCliMocks.pool.end).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      [
        "Paired Telegram actor 123.",
        "identity identity-local",
        "connector 42",
      ].join("\n") + "\n",
    );
  });
});
