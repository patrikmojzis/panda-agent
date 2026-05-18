import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";

import {registerConnectorCommands} from "../src/domain/connectors/cli.js";

const connectorCliMocks = vi.hoisted(() => {
  const privatePlaintextSentinel = "private-plaintext-sentinel";
  const privateCiphertextSentinel = "private-ciphertext-sentinel";
  const createdAt = Date.UTC(2026, 3, 10, 12, 30, 0);
  const updatedAt = Date.UTC(2026, 3, 10, 12, 31, 0);
  const secretUpdatedAt = Date.UTC(2026, 3, 10, 12, 32, 0);

  const pool = {
    end: vi.fn(async () => {}),
  };

  const storeInstances: MockPostgresConnectorAccountStore[] = [];
  const state: {
    listAccountsResult: Record<string, unknown>[];
    getAccountByKeyResult: Record<string, unknown> | null;
    enableAccountResult: Record<string, unknown>;
    disableAccountResult: Record<string, unknown>;
    secretSummariesByAccountId: Map<string, Record<string, unknown>[]>;
  } = {
    listAccountsResult: [],
    getAccountByKeyResult: null,
    enableAccountResult: {},
    disableAccountResult: {},
    secretSummariesByAccountId: new Map(),
  };

  function makeAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "account-1",
      source: "discord",
      accountKey: "ops",
      connectorKey: "connector-1",
      ownerKind: "system",
      ownerIdentityId: null,
      ownerAgentKey: null,
      displayName: "Ops Connector",
      externalAccountId: "external-account-1",
      externalUsername: "ops-connector",
      status: "enabled",
      config: {
        enabledFeature: true,
        privatePlaintextSentinel,
      },
      metadata: {
        privateCiphertextSentinel,
      },
      createdAt,
      updatedAt,
      ...overrides,
    };
  }

  function makeSecretSummary(secretKey: string): Record<string, unknown> {
    return {
      accountId: "account-1",
      secretKey,
      createdAt,
      updatedAt: secretUpdatedAt,
    };
  }

  function resetFixtures(): void {
    const enabledAccount = makeAccount({status: "enabled"});
    const disabledAccount = makeAccount({status: "disabled"});
    state.listAccountsResult = [enabledAccount];
    state.getAccountByKeyResult = enabledAccount;
    state.enableAccountResult = enabledAccount;
    state.disableAccountResult = disabledAccount;
    state.secretSummariesByAccountId = new Map([
      ["account-1", [makeSecretSummary("primary"), makeSecretSummary("backup")]],
    ]);
  }

  class MockPostgresConnectorAccountStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly listAccounts = vi.fn(async () => state.listAccountsResult);
    readonly getAccountByKey = vi.fn(async () => state.getAccountByKeyResult);
    readonly enableAccount = vi.fn(async () => state.enableAccountResult);
    readonly disableAccount = vi.fn(async () => state.disableAccountResult);
    readonly listSecretKeys = vi.fn(async (accountId: string) => state.secretSummariesByAccountId.get(accountId) ?? []);

    constructor(_options: unknown) {
      storeInstances.push(this);
    }
  }

  resetFixtures();

  return {
    pool,
    privateCiphertextSentinel,
    privatePlaintextSentinel,
    resetFixtures,
    state,
    storeInstances,
    MockPostgresConnectorAccountStore,
    withPostgresPool: vi.fn(async (_dbUrl: string | undefined, fn: (pool: typeof pool) => Promise<unknown>) => {
      try {
        return await fn(pool);
      } finally {
        await pool.end();
      }
    }),
  };
});

vi.mock("../src/domain/connectors/postgres.js", () => ({
  PostgresConnectorAccountStore: connectorCliMocks.MockPostgresConnectorAccountStore,
}));

vi.mock("../src/lib/postgres-bootstrap.js", () => ({
  withPostgresPool: connectorCliMocks.withPostgresPool,
}));

function createProgram(): Command {
  const program = new Command();
  registerConnectorCommands(program);
  return program;
}

function latestStore(): InstanceType<typeof connectorCliMocks.MockPostgresConnectorAccountStore> {
  const store = connectorCliMocks.storeInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked connector account store instance.");
  }

  return store;
}

function collectWrites(write: {mock: {calls: unknown[][]}}): string {
  return write.mock.calls.map((call) => String(call[0])).join("");
}

describe("Connector account CLI", () => {
  afterEach(() => {
    connectorCliMocks.storeInstances.length = 0;
    connectorCliMocks.pool.end.mockClear();
    connectorCliMocks.withPostgresPool.mockClear();
    connectorCliMocks.resetFixtures();
    vi.restoreAllMocks();
  });

  it("lists connector accounts with source filtering and only safe secret presence", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["connector", "account", "list", "--source", "Discord", "--db-url", "postgres://connectors-db"],
      {from: "user"},
    );

    const store = latestStore();
    expect(store.ensureSchema).toHaveBeenCalledOnce();
    expect(store.listAccounts).toHaveBeenCalledWith({source: "discord"});
    expect(store.listSecretKeys).toHaveBeenCalledWith("account-1");
    expect(connectorCliMocks.withPostgresPool).toHaveBeenCalledWith(
      "postgres://connectors-db",
      expect.any(Function),
    );
    expect(connectorCliMocks.pool.end).toHaveBeenCalledOnce();

    const output = collectWrites(write);
    expect(output).toContain("discord/ops\n");
    expect(output).toContain("  connector connector-1\n");
    expect(output).toContain("  status enabled\n");
    expect(output).toContain("  owner system\n");
    expect(output).toContain("  config present\n");
    expect(output).toContain("  metadata present\n");
    expect(output).toContain("  secrets 2 present\n");
    expect(output).not.toContain(connectorCliMocks.privatePlaintextSentinel);
    expect(output).not.toContain(connectorCliMocks.privateCiphertextSentinel);
    expect(output).not.toContain("value_ciphertext");
  });

  it("inspects one connector account without rendering arbitrary config or metadata values", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["connector", "account", "inspect", "Discord", "ops", "--db-url", "postgres://connectors-db"],
      {from: "user"},
    );

    const store = latestStore();
    expect(store.getAccountByKey).toHaveBeenCalledWith("discord", "ops");
    expect(store.listSecretKeys).toHaveBeenCalledWith("account-1");

    const output = collectWrites(write);
    expect(output).toContain("Connector account discord/ops\n");
    expect(output).toContain("id account-1\n");
    expect(output).toContain("connector connector-1\n");
    expect(output).toContain("secrets 2 present\n");
    expect(output).toContain("  primary present · updated 2026-04-10T12:32:00.000Z\n");
    expect(output).toContain("  backup present · updated 2026-04-10T12:32:00.000Z\n");
    expect(output).not.toContain(connectorCliMocks.privatePlaintextSentinel);
    expect(output).not.toContain(connectorCliMocks.privateCiphertextSentinel);
    expect(output).not.toContain("value_ciphertext");
  });

  it("fails loudly for a missing account", async () => {
    connectorCliMocks.state.getAccountByKeyResult = null;

    await expect(createProgram().parseAsync(
      ["connector", "account", "inspect", "Discord", "missing", "--db-url", "postgres://connectors-db"],
      {from: "user"},
    )).rejects.toThrow("Unknown connector account discord/missing.");

    expect(latestStore().getAccountByKey).toHaveBeenCalledWith("discord", "missing");
  });

  it("enables and disables connector accounts through the K1 store", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["connector", "account", "enable", "Discord", "ops", "--db-url", "postgres://connectors-db"],
      {from: "user"},
    );
    const enableStore = latestStore();

    await createProgram().parseAsync(
      ["connector", "account", "disable", "Discord", "ops", "--db-url", "postgres://connectors-db"],
      {from: "user"},
    );
    const disableStore = latestStore();

    expect(enableStore.enableAccount).toHaveBeenCalledWith("discord", "ops");
    expect(disableStore.disableAccount).toHaveBeenCalledWith("discord", "ops");

    const output = collectWrites(write);
    expect(output).toContain("Enabled connector account discord/ops.\nconnector connector-1\nstatus enabled\nsecrets 2 present\n");
    expect(output).toContain("Disabled connector account discord/ops.\nconnector connector-1\nstatus disabled\nsecrets 2 present\n");
    expect(output).not.toContain(connectorCliMocks.privatePlaintextSentinel);
    expect(output).not.toContain(connectorCliMocks.privateCiphertextSentinel);
  });
});
