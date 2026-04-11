import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";
import {registerIdentityCommands} from "../src/domain/identity/cli.js";

const identityCliMocks = vi.hoisted(() => {
  const HOME_NEXT_FIRE_AT = Date.UTC(2026, 3, 10, 12, 30, 0);
  const UPDATED_NEXT_FIRE_AT = Date.UTC(2026, 3, 10, 13, 0, 0);
  const pool = {
    end: vi.fn(async () => {}),
  };

  const identityStoreInstances: MockPostgresIdentityStore[] = [];
  const agentStoreInstances: MockPostgresAgentStore[] = [];
  const homeThreadStoreInstances: MockPostgresHomeThreadStore[] = [];
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

  class MockPostgresHomeThreadStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly resolveHomeThread = vi.fn(async () => ({
      identityId: "local",
      threadId: "thread-home",
      heartbeat: {
        enabled: true,
        everyMinutes: 30,
        nextFireAt: HOME_NEXT_FIRE_AT,
      },
      createdAt: 1,
      updatedAt: 1,
    }));
    readonly updateHeartbeatConfig = vi.fn(async (input: {
      identityId: string;
      enabled?: boolean;
      everyMinutes?: number;
    }) => ({
      identityId: input.identityId,
      threadId: "thread-home",
      heartbeat: {
        enabled: input.enabled ?? true,
        everyMinutes: input.everyMinutes ?? 30,
        nextFireAt: UPDATED_NEXT_FIRE_AT,
      },
      createdAt: 1,
      updatedAt: 2,
    }));

    constructor(_options: unknown) {
      homeThreadStoreInstances.push(this);
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
    HOME_NEXT_FIRE_AT,
    UPDATED_NEXT_FIRE_AT,
    identityStoreInstances,
    agentStoreInstances,
    homeThreadStoreInstances,
    pandaClients,
    MockPostgresIdentityStore,
    MockPostgresAgentStore,
    MockPostgresHomeThreadStore,
    MockPandaClient,
    createPandaPool: vi.fn(() => pool),
    requirePandaDatabaseUrl: vi.fn((dbUrl?: string) => dbUrl ?? "postgres://resolved-db"),
    createPandaClient: vi.fn(async () => new MockPandaClient()),
  };
});

vi.mock("../src/domain/identity/postgres.js", () => ({
  PostgresIdentityStore: identityCliMocks.MockPostgresIdentityStore,
}));

vi.mock("../src/domain/agents/postgres.js", () => ({
  PostgresAgentStore: identityCliMocks.MockPostgresAgentStore,
}));

vi.mock("../src/domain/threads/home/index.js", () => ({
  PostgresHomeThreadStore: identityCliMocks.MockPostgresHomeThreadStore,
}));

vi.mock("../src/app/runtime/create-runtime.js", () => ({
  createPandaPool: identityCliMocks.createPandaPool,
  requirePandaDatabaseUrl: identityCliMocks.requirePandaDatabaseUrl,
}));

vi.mock("../src/app/runtime/client.js", () => ({
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

function latestHomeThreadStore(): InstanceType<typeof identityCliMocks.MockPostgresHomeThreadStore> {
  const store = identityCliMocks.homeThreadStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked home thread store instance.");
  }

  return store;
}

describe("Identity CLI", () => {
  afterEach(() => {
    identityCliMocks.identityStoreInstances.length = 0;
    identityCliMocks.agentStoreInstances.length = 0;
    identityCliMocks.homeThreadStoreInstances.length = 0;
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

  it("inspects heartbeat config without waking the daemon", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["identity", "heartbeat", "local", "--db-url", "postgres://identity-db"],
      {from: "user"},
    );

    expect(latestHomeThreadStore().resolveHomeThread).toHaveBeenCalledWith({
      identityId: "local",
    });
    expect(latestHomeThreadStore().updateHeartbeatConfig).not.toHaveBeenCalled();
    expect(identityCliMocks.createPandaClient).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      [
        "Heartbeat for local.",
        "home thread thread-home",
        "enabled yes",
        "every 30 minutes",
        `next fire ${new Date(identityCliMocks.HOME_NEXT_FIRE_AT).toISOString()}`,
        "last fire -",
        "last skip -",
      ].join("\n") + "\n",
    );
  });

  it("updates heartbeat config directly in the home-thread store", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["identity", "heartbeat", "local", "--disable", "--every", "45", "--db-url", "postgres://identity-db"],
      {from: "user"},
    );

    expect(latestHomeThreadStore().updateHeartbeatConfig).toHaveBeenCalledWith({
      identityId: "local",
      enabled: false,
      everyMinutes: 45,
    });
    expect(identityCliMocks.createPandaClient).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith(
      [
        "Updated heartbeat for local.",
        "home thread thread-home",
        "enabled no",
        "every 45 minutes",
        "next fire -",
        "last fire -",
        "last skip -",
      ].join("\n") + "\n",
    );
  });
});
