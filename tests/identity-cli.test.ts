import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";
import {registerIdentityCommands} from "../src/features/identity/cli.js";

const identityCliMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => {}),
  };

  const identityStoreInstances: MockPostgresIdentityStore[] = [];
  const agentStoreInstances: MockPostgresAgentStore[] = [];
  const pandaClients: MockPandaClient[] = [];

  class MockPostgresIdentityStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly getIdentity = vi.fn(async () => ({
      id: "local",
      handle: "local",
      displayName: "Local",
      defaultAgentKey: "jozef",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    }));
    readonly getIdentityByHandle = vi.fn(async (handle: string) => ({
      id: handle === "local" ? "local" : `${handle}-id`,
      handle,
      displayName: handle,
      defaultAgentKey: "jozef",
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    }));
    readonly updateIdentity = vi.fn(async (input: {identityId: string; defaultAgentKey?: string | null}) => ({
      id: input.identityId,
      handle: input.identityId === "local" ? "local" : input.identityId,
      displayName: input.identityId,
      defaultAgentKey: input.defaultAgentKey ?? undefined,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 2,
    }));

    constructor(_options: unknown) {
      identityStoreInstances.push(this);
    }
  }

  class MockPostgresAgentStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly getAgent = vi.fn(async (agentKey: string) => ({
      agentKey,
      displayName: agentKey,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    }));

    constructor(_options: unknown) {
      agentStoreInstances.push(this);
    }
  }

  class MockPandaClient {
    readonly switchHomeAgent = vi.fn(async (agentKey: string) => ({
      thread: {
        id: "thread-luna",
        identityId: "local",
        agentKey,
        context: {},
        createdAt: 1,
        updatedAt: 1,
      },
      previousThreadId: "thread-jozef",
    }));
    readonly close = vi.fn(async () => {});

    constructor() {
      pandaClients.push(this);
    }
  }

  return {
    pool,
    identityStoreInstances,
    agentStoreInstances,
    pandaClients,
    MockPostgresIdentityStore,
    MockPostgresAgentStore,
    MockPandaClient,
    createPandaPool: vi.fn(() => pool),
    requirePandaDatabaseUrl: vi.fn((dbUrl?: string) => dbUrl ?? "postgres://resolved-db"),
    createPandaClient: vi.fn(async () => new MockPandaClient()),
  };
});

vi.mock("../src/features/identity/postgres.js", () => ({
  PostgresIdentityStore: identityCliMocks.MockPostgresIdentityStore,
}));

vi.mock("../src/features/agents/postgres.js", () => ({
  PostgresAgentStore: identityCliMocks.MockPostgresAgentStore,
}));

vi.mock("../src/features/panda/runtime.js", () => ({
  createPandaPool: identityCliMocks.createPandaPool,
  requirePandaDatabaseUrl: identityCliMocks.requirePandaDatabaseUrl,
}));

vi.mock("../src/features/panda/client.js", () => ({
  createPandaClient: identityCliMocks.createPandaClient,
}));

function createProgram(): Command {
  const program = new Command();
  registerIdentityCommands(program);
  return program;
}

function latestIdentityStore(): InstanceType<typeof identityCliMocks.MockPostgresIdentityStore> {
  const store = identityCliMocks.identityStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked identity store instance.");
  }

  return store;
}

function latestAgentStore(): InstanceType<typeof identityCliMocks.MockPostgresAgentStore> {
  const store = identityCliMocks.agentStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked agent store instance.");
  }

  return store;
}

function latestPandaClient(): InstanceType<typeof identityCliMocks.MockPandaClient> {
  const client = identityCliMocks.pandaClients.at(-1);
  if (!client) {
    throw new Error("Expected a mocked Panda client instance.");
  }

  return client;
}

describe("Identity CLI", () => {
  afterEach(() => {
    identityCliMocks.identityStoreInstances.length = 0;
    identityCliMocks.agentStoreInstances.length = 0;
    identityCliMocks.pandaClients.length = 0;
    identityCliMocks.pool.end.mockClear();
    identityCliMocks.createPandaPool.mockClear();
    identityCliMocks.requirePandaDatabaseUrl.mockClear();
    identityCliMocks.createPandaClient.mockClear();
    vi.restoreAllMocks();
  });

  it("keeps set-default-agent config-only", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["identity", "set-default-agent", "local", "luna", "--db-url", "postgres://identity-db"],
      {from: "user"},
    );

    expect(latestAgentStore().getAgent).toHaveBeenCalledWith("luna");
    expect(latestIdentityStore().updateIdentity).toHaveBeenCalledWith({
      identityId: "local",
      defaultAgentKey: "luna",
    });
    expect(identityCliMocks.createPandaClient).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      [
        "Updated identity local.",
        "default agent luna",
        "current home unchanged",
      ].join("\n") + "\n",
    );
  });

  it("switches the home agent through the daemon-backed client", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["identity", "switch-home-agent", "local", "luna", "--db-url", "postgres://identity-db"],
      {from: "user"},
    );

    expect(latestAgentStore().getAgent).toHaveBeenCalledWith("luna");
    expect(identityCliMocks.createPandaClient).toHaveBeenCalledWith({
      identity: "local",
      dbUrl: "postgres://identity-db",
    });
    expect(latestPandaClient().switchHomeAgent).toHaveBeenCalledWith("luna");
    expect(latestPandaClient().close).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      [
        "Switched identity local to agent luna.",
        "new home thread-luna",
        "previous home thread-jozef",
      ].join("\n") + "\n",
    );
  });
});
