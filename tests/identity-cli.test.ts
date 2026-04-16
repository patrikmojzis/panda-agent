import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";
import {registerIdentityCommands} from "../src/domain/identity/cli.js";

const identityCliMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => {}),
  };

  const identityStoreInstances: MockPostgresIdentityStore[] = [];

  class MockPostgresIdentityStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly listIdentities = vi.fn(async () => ([
      {
        id: "local",
        handle: "local",
        displayName: "Local",
        status: "active" as const,
        createdAt: Date.UTC(2026, 3, 10, 12, 30, 0),
        updatedAt: Date.UTC(2026, 3, 10, 12, 30, 0),
      },
    ]));
    readonly createIdentity = vi.fn(async (input: {id: string; handle: string; displayName: string}) => ({
      ...input,
      status: "active" as const,
      createdAt: Date.UTC(2026, 3, 10, 13, 0, 0),
      updatedAt: Date.UTC(2026, 3, 10, 13, 0, 0),
    }));

    constructor(_options: unknown) {
      identityStoreInstances.push(this);
    }
  }

  return {
    pool,
    identityStoreInstances,
    MockPostgresIdentityStore,
    ensureSchemas: vi.fn(async (resources: Array<{ ensureSchema(): Promise<void> }>) => {
      for (const resource of resources) {
        await resource.ensureSchema();
      }
    }),
    randomUUID: vi.fn(() => "identity-created"),
    withPostgresPool: vi.fn(async (_dbUrl: string | undefined, fn: (pool: typeof pool) => Promise<unknown>) => {
      try {
        return await fn(pool);
      } finally {
        await pool.end();
      }
    }),
  };
});

vi.mock("node:crypto", () => ({
  randomUUID: identityCliMocks.randomUUID,
}));

vi.mock("../src/domain/identity/postgres.js", () => ({
  PostgresIdentityStore: identityCliMocks.MockPostgresIdentityStore,
}));

vi.mock("../src/app/runtime/postgres-bootstrap.js", () => ({
  ensureSchemas: identityCliMocks.ensureSchemas,
  withPostgresPool: identityCliMocks.withPostgresPool,
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

describe("Identity CLI", () => {
  afterEach(() => {
    identityCliMocks.identityStoreInstances.length = 0;
    identityCliMocks.pool.end.mockClear();
    identityCliMocks.ensureSchemas.mockClear();
    identityCliMocks.randomUUID.mockClear();
    identityCliMocks.withPostgresPool.mockClear();
    vi.restoreAllMocks();
  });

  it("lists stored identities", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["identity", "list", "--db-url", "postgres://identity-db"],
      {from: "user"},
    );

    expect(latestIdentityStore().ensureSchema).toHaveBeenCalledOnce();
    expect(latestIdentityStore().listIdentities).toHaveBeenCalledOnce();
    expect(identityCliMocks.withPostgresPool).toHaveBeenCalledWith(
      "postgres://identity-db",
      expect.any(Function),
    );
    expect(identityCliMocks.pool.end).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      "local\n  id local · status active\n  created 2026-04-10T12:30:00.000Z\n\n",
    );
  });

  it("creates an identity with a generated id", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["identity", "create", "alice", "--name", "Alice", "--db-url", "postgres://identity-db"],
      {from: "user"},
    );

    expect(latestIdentityStore().createIdentity).toHaveBeenCalledWith({
      id: "identity-created",
      handle: "alice",
      displayName: "Alice",
    });
    expect(identityCliMocks.randomUUID).toHaveBeenCalledOnce();
    expect(identityCliMocks.pool.end).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith("Created identity alice.\nid identity-created\n");
  });
});
