import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";

import {registerCredentialCommands} from "../src/domain/credentials/cli.js";

const credentialCliMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => {}),
  };
  const resolveCredentialResult = {
    current: {
      id: "credential-2",
      envKey: "NOTION_API_KEY",
      value: "secret-notion",
      valuePreview: "secr...tion",
      agentKey: "panda",
      keyVersion: 1,
      createdAt: 1,
      updatedAt: 2,
    } as {
      id: string;
      envKey: string;
      value: string;
      valuePreview: string;
      agentKey: string;
      keyVersion: number;
      createdAt: number;
      updatedAt: number;
    } | null,
  };

  const agentStoreInstances: MockPostgresAgentStore[] = [];
  const credentialStoreInstances: MockPostgresCredentialStore[] = [];
  const credentialServiceInstances: MockCredentialService[] = [];

  class MockPostgresAgentStore {
    readonly ensureAgentTableSchema = vi.fn(async () => {});
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

  class MockPostgresCredentialStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly deleteCredential = vi.fn(async () => true);

    constructor(_options: unknown) {
      credentialStoreInstances.push(this);
    }
  }

  class MockCredentialService {
    readonly setCredential = vi.fn(async (input: Record<string, unknown>) => ({
      id: "credential-1",
      envKey: String(input.envKey),
      value: String(input.value),
      valuePreview: "sk-l...8484",
      agentKey: input.agentKey,
      keyVersion: 1,
      createdAt: 1,
      updatedAt: 2,
    }));
    readonly clearCredential = vi.fn(async () => true);
    readonly listCredentials = vi.fn(async () => ([
      {
        id: "credential-1",
        envKey: "OPENAI_API_KEY",
        value: "sk-live-339398484",
        valuePreview: "sk-l...8484",
        agentKey: "panda",
        keyVersion: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ]));
    readonly resolveCredential = vi.fn(async () => resolveCredentialResult.current);

    constructor(_options: unknown) {
      credentialServiceInstances.push(this);
    }
  }

  return {
    agentStoreInstances,
    credentialServiceInstances,
    credentialStoreInstances,
    pool,
    resolveCredentialResult,
    resolveCredentialCrypto: vi.fn(() => ({kind: "crypto"})),
    MockCredentialService,
    MockPostgresAgentStore,
    MockPostgresCredentialStore,
    withPostgresPool: vi.fn(async (_dbUrl: string | undefined, fn: (pool: typeof pool) => Promise<unknown>) => {
      try {
        return await fn(pool);
      } finally {
        await pool.end();
      }
    }),
  };
});

vi.mock("../src/domain/agents/postgres.js", () => ({
  PostgresAgentStore: credentialCliMocks.MockPostgresAgentStore,
}));

vi.mock("../src/domain/credentials/postgres.js", () => ({
  PostgresCredentialStore: credentialCliMocks.MockPostgresCredentialStore,
}));

vi.mock("../src/domain/credentials/resolver.js", () => ({
  CredentialService: credentialCliMocks.MockCredentialService,
}));

vi.mock("../src/domain/credentials/crypto.js", () => ({
  resolveCredentialCrypto: credentialCliMocks.resolveCredentialCrypto,
}));

vi.mock("../src/app/runtime/postgres-bootstrap.js", () => ({
  withPostgresPool: credentialCliMocks.withPostgresPool,
}));

function createProgram(): Command {
  const program = new Command();
  registerCredentialCommands(program);
  return program;
}

function latestService(): InstanceType<typeof credentialCliMocks.MockCredentialService> {
  const service = credentialCliMocks.credentialServiceInstances.at(-1);
  if (!service) {
    throw new Error("Expected a mocked credential service instance.");
  }

  return service;
}

function latestCredentialStore(): InstanceType<typeof credentialCliMocks.MockPostgresCredentialStore> {
  const store = credentialCliMocks.credentialStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked credential store instance.");
  }

  return store;
}

describe("Credential CLI", () => {
  afterEach(() => {
    credentialCliMocks.agentStoreInstances.length = 0;
    credentialCliMocks.credentialStoreInstances.length = 0;
    credentialCliMocks.credentialServiceInstances.length = 0;
    credentialCliMocks.pool.end.mockClear();
    credentialCliMocks.resolveCredentialCrypto.mockClear();
    credentialCliMocks.resolveCredentialResult.current = {
      id: "credential-2",
      envKey: "NOTION_API_KEY",
      value: "secret-notion",
      valuePreview: "secr...tion",
      agentKey: "panda",
      keyVersion: 1,
      createdAt: 1,
      updatedAt: 2,
    };
    credentialCliMocks.withPostgresPool.mockClear();
    vi.restoreAllMocks();
  });

  it("sets a credential for one agent", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      [
        "credentials",
        "set",
        "OPENAI_API_KEY",
        "sk-live-339398484",
        "--agent",
        "panda",
        "--db-url",
        "postgres://credentials-db",
      ],
      {from: "user"},
    );

    expect(latestService().setCredential).toHaveBeenCalledWith({
      envKey: "OPENAI_API_KEY",
      value: "sk-live-339398484",
      agentKey: "panda",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "Stored OPENAI_API_KEY.",
        "agent panda",
        "value sk-l...8484",
      ].join("\n") + "\n",
    );
  });

  it("clears one agent credential", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      [
        "credentials",
        "clear",
        "NOTION_API_KEY",
        "--agent",
        "panda",
        "--db-url",
        "postgres://credentials-db",
      ],
      {from: "user"},
    );

    expect(latestCredentialStore().deleteCredential).toHaveBeenCalledWith("NOTION_API_KEY", {
      agentKey: "panda",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "Cleared NOTION_API_KEY.",
        "agent panda",
      ].join("\n") + "\n",
    );
  });

  it("clears credentials even when the master key is missing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    credentialCliMocks.resolveCredentialCrypto.mockReturnValueOnce(null);

    await createProgram().parseAsync(
      [
        "credentials",
        "clear",
        "OPENAI_API_KEY",
        "--agent",
        "panda",
        "--db-url",
        "postgres://credentials-db",
      ],
      {from: "user"},
    );

    expect(credentialCliMocks.credentialServiceInstances).toHaveLength(0);
    expect(latestCredentialStore().deleteCredential).toHaveBeenCalledWith("OPENAI_API_KEY", {
      agentKey: "panda",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "Cleared OPENAI_API_KEY.",
        "agent panda",
      ].join("\n") + "\n",
    );
  });

  it("lists masked previews and resolves the winning stored credential", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      ["credentials", "list", "--db-url", "postgres://credentials-db"],
      {from: "user"},
    );
    const listService = latestService();
    await createProgram().parseAsync(
      [
        "credentials",
        "resolve",
        "NOTION_API_KEY",
        "--agent",
        "panda",
        "--db-url",
        "postgres://credentials-db",
      ],
      {from: "user"},
    );

    expect(listService.listCredentials).toHaveBeenCalledWith({});
    expect(latestService().resolveCredential).toHaveBeenCalledWith("NOTION_API_KEY", {
      agentKey: "panda",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "OPENAI_API_KEY",
        "  agent panda",
        "  value sk-l...8484",
        "  updated 1970-01-01T00:00:00.002Z",
      ].join("\n") + "\n",
    );
    expect(write).toHaveBeenCalledWith(
      [
        "Stored winner for NOTION_API_KEY.",
        "agent panda",
        "value secr...tion",
        "Note: this inspects stored credentials only.",
      ].join("\n") + "\n",
    );
  });

  it("makes the no-stored-match case explicit about local process env fallback", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    credentialCliMocks.resolveCredentialResult.current = null;

    await createProgram().parseAsync(
      [
        "credentials",
        "resolve",
        "OPENAI_API_KEY",
        "--agent",
        "panda",
        "--db-url",
        "postgres://credentials-db",
      ],
      {from: "user"},
    );

    expect(write).toHaveBeenCalledWith(
      [
        "No stored credential matched OPENAI_API_KEY.",
        "Note: local bash may still fall back to Panda process env.",
      ].join("\n") + "\n",
    );
  });
});
