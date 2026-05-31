import {Command} from "commander";
import {afterEach, describe, expect, it, vi} from "vitest";
import {registerControlCommands} from "../src/domain/control/cli.js";

const controlCliMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => {}),
  };

  const identities = new Map<string, {id: string; handle: string}>();

  class MockPostgresIdentityStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly getIdentity = vi.fn(async (identityId: string) => {
      const identity = [...identities.values()].find((candidate) => candidate.id === identityId);
      if (!identity) {
        throw new Error(`Unknown identity ${identityId}`);
      }

      return identity;
    });
    readonly getIdentityByHandle = vi.fn(async (handle: string) => {
      const identity = identities.get(handle);
      if (!identity) {
        throw new Error(`Unknown identity handle ${handle}`);
      }

      return identity;
    });

    constructor(_options: unknown) {
      identityStoreInstances.push(this);
    }
  }

  const identityStoreInstances: MockPostgresIdentityStore[] = [];

  class MockPostgresControlAuthService {
    readonly ensureSchema = vi.fn(async () => {});
    readonly createGrant = vi.fn(async (input: {identityId: string; role: "admin" | "scoped"; agentKey?: string; label?: string}) => ({
      grant: {
        id: "grant-created",
        identityId: input.identityId,
        role: input.role,
        agentKey: input.agentKey,
        label: input.label,
        active: true,
        loginTokenExpiresAt: Date.UTC(2026, 4, 31, 20, 0, 0),
        createdAt: Date.UTC(2026, 4, 31, 19, 45, 0),
        updatedAt: Date.UTC(2026, 4, 31, 19, 45, 0),
      },
      loginToken: "pct_test_token",
    }));

    constructor(_options: unknown) {
      controlAuthInstances.push(this);
    }
  }

  const controlAuthInstances: MockPostgresControlAuthService[] = [];

  return {
    pool,
    identities,
    identityStoreInstances,
    controlAuthInstances,
    MockPostgresIdentityStore,
    MockPostgresControlAuthService,
    withPostgresPool: vi.fn(async (_dbUrl: string | undefined, fn: (pool: typeof pool) => Promise<unknown>) => {
      try {
        return await fn(pool);
      } finally {
        await pool.end();
      }
    }),
  };
});

vi.mock("../src/app/runtime/postgres-bootstrap.js", () => ({
  withPostgresPool: controlCliMocks.withPostgresPool,
}));

vi.mock("../src/domain/identity/postgres.js", () => ({
  PostgresIdentityStore: controlCliMocks.MockPostgresIdentityStore,
}));

vi.mock("../src/domain/control/auth.js", () => ({
  PostgresControlAuthService: controlCliMocks.MockPostgresControlAuthService,
}));

function createProgram(): Command {
  const program = new Command();
  registerControlCommands(program);
  return program;
}

function latestIdentityStore(): InstanceType<typeof controlCliMocks.MockPostgresIdentityStore> {
  const store = controlCliMocks.identityStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked identity store instance.");
  }

  return store;
}

function latestControlAuth(): InstanceType<typeof controlCliMocks.MockPostgresControlAuthService> {
  const auth = controlCliMocks.controlAuthInstances.at(-1);
  if (!auth) {
    throw new Error("Expected a mocked Control auth instance.");
  }

  return auth;
}

describe("Control CLI", () => {
  afterEach(() => {
    controlCliMocks.identities.clear();
    controlCliMocks.identityStoreInstances.length = 0;
    controlCliMocks.controlAuthInstances.length = 0;
    controlCliMocks.pool.end.mockClear();
    controlCliMocks.withPostgresPool.mockClear();
    vi.restoreAllMocks();
  });

  it("creates a Control grant for an identity handle", async () => {
    controlCliMocks.identities.set("patrik", {id: "identity-patrik-id", handle: "patrik"});
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["control", "grant", "--identity", "patrik", "--role", "scoped", "--agent", "clawd", "--db-url", "postgres://control-db"],
      {from: "user"},
    );

    expect(latestIdentityStore().ensureSchema).toHaveBeenCalledOnce();
    expect(latestControlAuth().ensureSchema).toHaveBeenCalledOnce();
    expect(latestIdentityStore().getIdentityByHandle).toHaveBeenCalledWith("patrik");
    expect(latestControlAuth().createGrant).toHaveBeenCalledWith({
      identityId: "identity-patrik-id",
      role: "scoped",
      agentKey: "clawd",
      label: undefined,
    });
    expect(controlCliMocks.withPostgresPool).toHaveBeenCalledWith("postgres://control-db", expect.any(Function));
    expect(write).toHaveBeenCalledWith(expect.stringContaining('"identityId": "identity-patrik-id"'));
  });

  it("preserves exact identity id grants", async () => {
    controlCliMocks.identities.set("patrik", {id: "identity-patrik-id", handle: "patrik"});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["control", "grant", "--identity", "identity-patrik-id", "--role", "admin"],
      {from: "user"},
    );

    expect(latestControlAuth().createGrant).toHaveBeenCalledWith({
      identityId: "identity-patrik-id",
      role: "admin",
      agentKey: undefined,
      label: undefined,
    });
  });

  it("fails with a friendly error before creating a grant for an unknown identity", async () => {
    await expect(createProgram().parseAsync(
      ["control", "grant", "--identity", "missing-user", "--role", "admin"],
      {from: "user"},
    )).rejects.toThrow("Unknown Control grant identity missing-user. Run `panda identity list` and pass an identity id or handle.");

    expect(latestControlAuth().createGrant).not.toHaveBeenCalled();
  });

  it("fails with a friendly error when an identity value is ambiguous", async () => {
    controlCliMocks.identities.set("identity-patrik-id", {id: "identity-other-id", handle: "identity-patrik-id"});
    controlCliMocks.identities.set("patrik", {id: "identity-patrik-id", handle: "patrik"});

    await expect(createProgram().parseAsync(
      ["control", "grant", "--identity", "identity-patrik-id", "--role", "admin"],
      {from: "user"},
    )).rejects.toThrow("Ambiguous Control grant identity identity-patrik-id");

    expect(latestControlAuth().createGrant).not.toHaveBeenCalled();
  });
});
