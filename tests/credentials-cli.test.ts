import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";

import {registerCredentialCommands} from "../src/domain/credentials/cli.js";

const credentialCliMocks = vi.hoisted(() => {
  const pool = {
    end: vi.fn(async () => {}),
  };

  const identityStoreInstances: MockPostgresIdentityStore[] = [];
  const agentStoreInstances: MockPostgresAgentStore[] = [];
  const credentialStoreInstances: MockPostgresCredentialStore[] = [];
  const credentialServiceInstances: MockCredentialService[] = [];

  class MockPostgresIdentityStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly getIdentity = vi.fn(async (identityId: string) => ({
      id: identityId,
      handle: identityId === "local-id" ? "local" : "alice",
      displayName: identityId,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
    }));
    readonly getIdentityByHandle = vi.fn(async (handle: string) => ({
      id: handle === "local" ? "local-id" : `${handle}-id`,
      handle,
      displayName: handle,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 1,
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
      scope: input.scope,
      agentKey: input.agentKey,
      identityId: input.identityId,
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
        scope: "relationship" as const,
        agentKey: "panda",
        identityId: "local-id",
        keyVersion: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    ]));
    readonly resolveCredential = vi.fn(async () => ({
      id: "credential-2",
      envKey: "NOTION_API_KEY",
      value: "secret-notion",
      valuePreview: "secr...tion",
      scope: "agent" as const,
      agentKey: "panda",
      identityId: undefined,
      keyVersion: 1,
      createdAt: 1,
      updatedAt: 2,
    }));

    constructor(_options: unknown) {
      credentialServiceInstances.push(this);
    }
  }

  return {
    agentStoreInstances,
    credentialServiceInstances,
    credentialStoreInstances,
    createPandaPool: vi.fn(() => pool),
    identityStoreInstances,
    pool,
    requirePandaDatabaseUrl: vi.fn((dbUrl?: string) => dbUrl ?? "postgres://resolved-db"),
    resolveCredentialCrypto: vi.fn(() => ({kind: "crypto"})),
    MockCredentialService,
    MockPostgresAgentStore,
    MockPostgresCredentialStore,
    MockPostgresIdentityStore,
  };
});

vi.mock("../src/domain/identity/postgres.js", () => ({
  PostgresIdentityStore: credentialCliMocks.MockPostgresIdentityStore,
}));

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

vi.mock("../src/app/runtime/create-runtime.js", () => ({
  createPandaPool: credentialCliMocks.createPandaPool,
  requirePandaDatabaseUrl: credentialCliMocks.requirePandaDatabaseUrl,
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
    credentialCliMocks.identityStoreInstances.length = 0;
    credentialCliMocks.agentStoreInstances.length = 0;
    credentialCliMocks.credentialStoreInstances.length = 0;
    credentialCliMocks.credentialServiceInstances.length = 0;
    credentialCliMocks.pool.end.mockClear();
    credentialCliMocks.createPandaPool.mockClear();
    credentialCliMocks.requirePandaDatabaseUrl.mockClear();
    credentialCliMocks.resolveCredentialCrypto.mockClear();
    vi.restoreAllMocks();
  });

  it("maps agent plus identity to relationship scope when setting a credential", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync(
      [
        "credentials",
        "set",
        "OPENAI_API_KEY",
        "sk-live-339398484",
        "--agent",
        "panda",
        "--identity",
        "local",
        "--db-url",
        "postgres://credentials-db",
      ],
      {from: "user"},
    );

    expect(latestService().setCredential).toHaveBeenCalledWith({
      envKey: "OPENAI_API_KEY",
      value: "sk-live-339398484",
      scope: "relationship",
      agentKey: "panda",
      identityId: "local-id",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "Stored OPENAI_API_KEY.",
        "scope relationship",
        "agent panda",
        "identity local",
        "value sk-l...8484",
      ].join("\n") + "\n",
    );
  });

  it("clears one exact scope instead of guessing", async () => {
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
      scope: "agent",
      agentKey: "panda",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "Cleared NOTION_API_KEY.",
        "scope agent",
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
        "--identity",
        "local",
        "--db-url",
        "postgres://credentials-db",
      ],
      {from: "user"},
    );

    expect(credentialCliMocks.credentialServiceInstances).toHaveLength(0);
    expect(latestCredentialStore().deleteCredential).toHaveBeenCalledWith("OPENAI_API_KEY", {
      scope: "relationship",
      agentKey: "panda",
      identityId: "local-id",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "Cleared OPENAI_API_KEY.",
        "scope relationship",
        "agent panda",
        "identity local",
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
        "--identity",
        "local",
        "--db-url",
        "postgres://credentials-db",
      ],
      {from: "user"},
    );

    expect(listService.listCredentials).toHaveBeenCalledWith({});
    expect(latestService().resolveCredential).toHaveBeenCalledWith("NOTION_API_KEY", {
      agentKey: "panda",
      identityId: "local-id",
    });
    expect(write).toHaveBeenCalledWith(
      [
        "OPENAI_API_KEY",
        "  scope relationship",
        "  agent panda",
        "  identity local",
        "  value sk-l...8484",
        "  updated 1970-01-01T00:00:00.002Z",
      ].join("\n") + "\n",
    );
    expect(write).toHaveBeenCalledWith(
      [
        "Resolved NOTION_API_KEY.",
        "scope agent",
        "agent panda",
        "value secr...tion",
      ].join("\n") + "\n",
    );
  });
});
