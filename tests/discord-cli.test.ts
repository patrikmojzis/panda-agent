import {afterEach, describe, expect, it, vi} from "vitest";
import {Command} from "commander";

import {registerDiscordCommands} from "../src/integrations/channels/discord/cli.js";
import {DISCORD_BOT_TOKEN_SECRET_KEY} from "../src/integrations/channels/discord/config.js";

const discordCliMocks = vi.hoisted(() => {
  const privateToken = "discord-private-token-fragment-12345678";
  const privateMetadataSentinel = "private-metadata-sentinel";
  const crypto = {kind: "crypto"};
  const pool = {
    end: vi.fn(async () => {}),
  };
  const botUser = {
    id: "123456789012345678",
    username: "panda-bot",
    displayName: "Panda Bot",
    globalName: "Panda Bot",
    bot: true,
  };

  const connectorStoreInstances: MockPostgresConnectorAccountStore[] = [];
  const identityStoreInstances: MockPostgresIdentityStore[] = [];
  const agentStoreInstances: MockPostgresAgentStore[] = [];
  const conversationRepoInstances: MockConversationRepo[] = [];
  const sessionStoreInstances: MockPostgresSessionStore[] = [];

  const state: {
    account: Record<string, unknown> | null;
    binding: Record<string, unknown> | null;
    deleteBindingResult: boolean;
    deleteIdentityBindingResult: boolean;
    ensureIdentityBindingError: Error | null;
    getIdentityByHandleError: Error | null;
    identityBinding: Record<string, unknown> | null;
    listAccountsResult: Record<string, unknown>[];
    listBindingsResult: Record<string, unknown>[];
    listIdentitiesResult: Record<string, unknown>[];
    listIdentityBindingsResult: Record<string, Record<string, unknown>[]>;
    sessionExists: boolean;
    storedSecret: string | null;
  } = {
    account: null,
    binding: null,
    deleteBindingResult: true,
    deleteIdentityBindingResult: true,
    ensureIdentityBindingError: null,
    getIdentityByHandleError: null,
    identityBinding: null,
    listAccountsResult: [],
    listBindingsResult: [],
    listIdentitiesResult: [],
    listIdentityBindingsResult: {},
    sessionExists: true,
    storedSecret: privateToken,
  };

  function makeAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "account-1",
      source: "discord",
      accountKey: "ops",
      connectorKey: botUser.id,
      ownerKind: "system",
      ownerIdentityId: null,
      ownerAgentKey: null,
      displayName: botUser.displayName,
      externalAccountId: botUser.id,
      externalUsername: botUser.username,
      status: "enabled",
      config: {},
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    };
  }

  function makeBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      source: "discord",
      connectorKey: botUser.id,
      externalConversationId: "channel-1",
      sessionId: "session-a",
      metadata: {
        boundVia: "discord-cli",
        accountKey: "ops",
        channelId: "channel-1",
      },
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    };
  }

  function makeIdentity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "identity-patrik",
      handle: "patrik",
      displayName: "Patrik",
      status: "active",
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    };
  }

  function makeIdentityBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "identity-binding-1",
      identityId: "identity-patrik",
      source: "discord",
      connectorKey: botUser.id,
      externalActorId: "234567890123456789",
      metadata: {
        pairedVia: "discord-cli",
        accountKey: "ops",
      },
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    };
  }

  function resetFixtures(): void {
    const account = makeAccount();
    state.account = account;
    state.binding = null;
    state.deleteBindingResult = true;
    state.deleteIdentityBindingResult = true;
    state.ensureIdentityBindingError = null;
    state.getIdentityByHandleError = null;
    state.identityBinding = null;
    state.listAccountsResult = [account];
    state.listBindingsResult = [];
    state.listIdentitiesResult = [];
    state.listIdentityBindingsResult = {};
    state.sessionExists = true;
    state.storedSecret = privateToken;
  }

  class MockPostgresConnectorAccountStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly upsertAccount = vi.fn(async (input: Record<string, unknown>) => {
      state.account = makeAccount({
        accountKey: input.accountKey,
        connectorKey: input.connectorKey,
        ownerKind: input.ownerIdentityId ? "identity" : input.ownerAgentKey ? "agent" : "system",
        ownerIdentityId: input.ownerIdentityId ?? null,
        ownerAgentKey: input.ownerAgentKey ?? null,
        displayName: input.displayName,
        externalAccountId: input.externalAccountId,
        externalUsername: input.externalUsername,
        status: input.status,
      });
      state.listAccountsResult = state.account ? [state.account] : [];
      return state.account;
    });
    readonly getAccountByKey = vi.fn(async (_source: string, _accountKey: string) => state.account);
    readonly listAccounts = vi.fn(async () => state.listAccountsResult);
    readonly disableAccount = vi.fn(async (_source: string, accountKey: string) => {
      state.account = makeAccount({
        accountKey,
        status: "disabled",
      });
      state.listAccountsResult = state.account ? [state.account] : [];
      return state.account;
    });
    readonly setSecret = vi.fn(async (_accountId: string, _secretKey: string, plaintext: string) => {
      state.storedSecret = plaintext;
      return {
        accountId: "account-1",
        secretKey: "bot_token",
        createdAt: 1,
        updatedAt: 2,
      };
    });
    readonly getSecret = vi.fn(async () => state.storedSecret);

    constructor(_options: unknown) {
      connectorStoreInstances.push(this);
    }
  }

  class MockConversationRepo {
    readonly ensureSchema = vi.fn(async () => {});
    readonly getConversationBinding = vi.fn(async () => state.binding);
    readonly createConversationBinding = vi.fn(async (input: Record<string, unknown>) => {
      const binding = makeBinding({
        connectorKey: input.connectorKey,
        externalConversationId: input.externalConversationId,
        sessionId: input.sessionId,
        metadata: input.metadata,
      });
      state.binding = binding;
      return binding;
    });
    readonly bindConversation = vi.fn(async (input: Record<string, unknown>) => {
      const previousSessionId = typeof state.binding?.sessionId === "string"
        ? state.binding.sessionId
        : undefined;
      const binding = makeBinding({
        connectorKey: input.connectorKey,
        externalConversationId: input.externalConversationId,
        sessionId: input.sessionId,
        metadata: input.metadata,
      });
      state.binding = binding;
      return {
        binding,
        ...(previousSessionId !== undefined && previousSessionId !== input.sessionId ? {previousSessionId} : {}),
      };
    });
    readonly deleteConversationBinding = vi.fn(async () => state.deleteBindingResult);
    readonly listConversationBindings = vi.fn(async () => state.listBindingsResult);

    constructor(_options: unknown) {
      conversationRepoInstances.push(this);
    }
  }

  class MockPostgresSessionStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly getSession = vi.fn(async (sessionId: string) => {
      if (!state.sessionExists) {
        throw new Error(`Unknown session ${sessionId}`);
      }

      return {
        id: sessionId,
        agentKey: "panda",
        kind: "main",
        currentThreadId: "thread-a",
        createdAt: 1,
        updatedAt: 2,
      };
    });
    readonly resolveSessionRef = vi.fn(async (input: {sessionRef: string; agentKey?: string}) => {
      if (input.sessionRef === "ops-inbox" && input.agentKey === "panda") {
        return this.getSession("session-canonical");
      }

      return this.getSession(input.sessionRef);
    });

    constructor(_options: unknown) {
      sessionStoreInstances.push(this);
    }
  }

  class MockPostgresIdentityStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly getIdentityByHandle = vi.fn(async (handle: string) => {
      if (state.getIdentityByHandleError) {
        throw state.getIdentityByHandleError;
      }

      return makeIdentity({
        id: `identity-${handle}`,
        handle,
        displayName: handle,
      });
    });
    readonly ensureIdentityBinding = vi.fn(async (input: Record<string, unknown>) => {
      if (state.ensureIdentityBindingError) {
        throw state.ensureIdentityBindingError;
      }

      state.identityBinding = makeIdentityBinding({
        identityId: input.identityId,
        source: input.source,
        connectorKey: input.connectorKey,
        externalActorId: input.externalActorId,
        metadata: input.metadata,
      });
      return state.identityBinding;
    });
    readonly deleteIdentityBinding = vi.fn(async () => state.deleteIdentityBindingResult);
    readonly listIdentities = vi.fn(async () => state.listIdentitiesResult);
    readonly listIdentityBindings = vi.fn(async (identityId: string) => (
      state.listIdentityBindingsResult[identityId] ?? []
    ));

    constructor(_options: unknown) {
      identityStoreInstances.push(this);
    }
  }

  class MockPostgresAgentStore {
    readonly getAgent = vi.fn(async (agentKey: string) => ({
      agentKey,
      displayName: agentKey,
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    }));

    constructor(_options: unknown) {
      agentStoreInstances.push(this);
    }
  }

  resetFixtures();

  return {
    agentStoreInstances,
    botUser,
    connectorStoreInstances,
    conversationRepoInstances,
    crypto,
    identityStoreInstances,
    makeAccount,
    makeBinding,
    makeIdentity,
    makeIdentityBinding,
    pool,
    privateMetadataSentinel,
    privateToken,
    resetFixtures,
    sessionStoreInstances,
    state,
    MockConversationRepo,
    MockPostgresAgentStore,
    MockPostgresConnectorAccountStore,
    MockPostgresIdentityStore,
    MockPostgresSessionStore,
    resolveCredentialCrypto: vi.fn(() => crypto),
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
  PostgresAgentStore: discordCliMocks.MockPostgresAgentStore,
}));

vi.mock("../src/domain/connectors/postgres.js", () => ({
  PostgresConnectorAccountStore: discordCliMocks.MockPostgresConnectorAccountStore,
}));

vi.mock("../src/domain/sessions/conversations/repo.js", () => ({
  ConversationRepo: discordCliMocks.MockConversationRepo,
}));

vi.mock("../src/domain/sessions/postgres.js", () => ({
  PostgresSessionStore: discordCliMocks.MockPostgresSessionStore,
}));

vi.mock("../src/domain/credentials/crypto.js", () => ({
  resolveCredentialCrypto: discordCliMocks.resolveCredentialCrypto,
}));

vi.mock("../src/domain/identity/postgres.js", () => ({
  PostgresIdentityStore: discordCliMocks.MockPostgresIdentityStore,
}));

vi.mock("../src/lib/postgres-bootstrap.js", () => ({
  withPostgresPool: discordCliMocks.withPostgresPool,
}));

function createProgram(overrides: {
  createRunService?: (options: {accountKey: string; dataDir: string; dbUrl?: string; poolMaxFallback?: number}) => {
    run(): Promise<void>;
    start?(): Promise<void>;
    stop(): Promise<void>;
  };
  getCurrentUser?: (token: string) => Promise<typeof discordCliMocks.botUser>;
  env?: NodeJS.ProcessEnv;
  readBotTokenFromStdin?: () => Promise<string>;
} = {}): Command {
  const program = new Command();
  registerDiscordCommands(program, {
    createRestClient: () => ({
      getCurrentUser: vi.fn(overrides.getCurrentUser ?? (async () => discordCliMocks.botUser)),
    }),
    env: overrides.env,
    readBotTokenFromStdin: overrides.readBotTokenFromStdin,
    createRunService: overrides.createRunService,
  });
  return program;
}

function latestConnectorStore(): InstanceType<typeof discordCliMocks.MockPostgresConnectorAccountStore> {
  const store = discordCliMocks.connectorStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked connector store instance.");
  }

  return store;
}

function latestConversationRepo(): InstanceType<typeof discordCliMocks.MockConversationRepo> {
  const repo = discordCliMocks.conversationRepoInstances.at(-1);
  if (!repo) {
    throw new Error("Expected a mocked conversation repo instance.");
  }

  return repo;
}

function latestSessionStore(): InstanceType<typeof discordCliMocks.MockPostgresSessionStore> {
  const store = discordCliMocks.sessionStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked session store instance.");
  }

  return store;
}

function latestIdentityStore(): InstanceType<typeof discordCliMocks.MockPostgresIdentityStore> {
  const store = discordCliMocks.identityStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked identity store instance.");
  }

  return store;
}

function latestAgentStore(): InstanceType<typeof discordCliMocks.MockPostgresAgentStore> {
  const store = discordCliMocks.agentStoreInstances.at(-1);
  if (!store) {
    throw new Error("Expected a mocked agent store instance.");
  }

  return store;
}

function collectWrites(write: {mock: {calls: unknown[][]}}): string {
  return write.mock.calls.map((call) => String(call[0])).join("");
}

describe("Discord account CLI", () => {
  afterEach(() => {
    discordCliMocks.agentStoreInstances.length = 0;
    discordCliMocks.connectorStoreInstances.length = 0;
    discordCliMocks.conversationRepoInstances.length = 0;
    discordCliMocks.identityStoreInstances.length = 0;
    discordCliMocks.sessionStoreInstances.length = 0;
    discordCliMocks.pool.end.mockClear();
    discordCliMocks.resolveCredentialCrypto.mockReset();
    discordCliMocks.resolveCredentialCrypto.mockImplementation(() => discordCliMocks.crypto);
    discordCliMocks.withPostgresPool.mockClear();
    discordCliMocks.resetFixtures();
    vi.restoreAllMocks();
  });


  it("runs one stored account worker with account key and db URL only", async () => {
    const run = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const createRunService = vi.fn(() => ({run, stop}));

    await createProgram({createRunService}).parseAsync([
      "discord",
      "run",
      "ops",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(createRunService).toHaveBeenCalledWith({
      accountKey: "ops",
      dataDir: expect.any(String),
      dbUrl: "postgres://discord-db",
    });
    expect(run).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
  });

  it("stops the one-account run worker on SIGINT without printing secrets", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handlers: Record<string, () => void> = {};
    const once = vi.spyOn(process, "once").mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
      handlers[String(event)] = () => listener();
      return process;
    });
    const off = vi.spyOn(process, "off").mockImplementation(() => process);
    const stop = vi.fn(async () => {});
    const run = vi.fn(async () => {
      handlers.SIGINT?.();
      await Promise.resolve();
    });

    await createProgram({
      createRunService: () => ({run, stop}),
    }).parseAsync([
      "discord",
      "run",
      "ops",
    ], {from: "user"});

    expect(once).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(once).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(stop).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(off).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    const output = collectWrites(write);
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("runs all enabled Discord accounts sequentially with a smaller pool fallback", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const order: string[] = [];
    discordCliMocks.state.listAccountsResult = [
      discordCliMocks.makeAccount({accountKey: "ops"}),
      discordCliMocks.makeAccount({accountKey: "lab", connectorKey: "345678901234567890"}),
    ];
    const createRunService = vi.fn((options: {accountKey: string; dataDir: string}) => ({
      start: vi.fn(async () => {
        order.push(`start:${options.accountKey}`);
      }),
      run: vi.fn(async () => {
        order.push(`run:${options.accountKey}`);
      }),
      stop: vi.fn(async () => {
        order.push(`stop:${options.accountKey}`);
      }),
    }));

    await createProgram({createRunService}).parseAsync([
      "discord",
      "run",
      "--all-enabled",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(latestConnectorStore().listAccounts).toHaveBeenCalledWith({
      source: "discord",
      status: "enabled",
    });
    expect(createRunService).toHaveBeenNthCalledWith(1, {
      accountKey: "ops",
      dataDir: expect.any(String),
      dbUrl: "postgres://discord-db",
      poolMaxFallback: 2,
    });
    expect(createRunService).toHaveBeenNthCalledWith(2, {
      accountKey: "lab",
      dataDir: expect.any(String),
      dbUrl: "postgres://discord-db",
      poolMaxFallback: 2,
    });
    expect(order.indexOf("start:ops")).toBeLessThan(order.indexOf("start:lab"));
    expect(order).toContain("stop:ops");
    expect(order).toContain("stop:lab");
  });

  it("requires all-enabled mode or one account key for Discord run", async () => {
    await expect(createProgram().parseAsync([
      "discord",
      "run",
    ], {from: "user"})).rejects.toThrow("Pass a Discord account key or --all-enabled.");

    await expect(createProgram().parseAsync([
      "discord",
      "run",
      "ops",
      "--all-enabled",
    ], {from: "user"})).rejects.toThrow("Choose either a Discord account key or --all-enabled, not both.");
  });

  it("fails helpfully when no Discord accounts are enabled for all-enabled run", async () => {
    discordCliMocks.state.listAccountsResult = [];

    await expect(createProgram().parseAsync([
      "discord",
      "run",
      "--all-enabled",
    ], {from: "user"})).rejects.toThrow("No enabled Discord accounts found. Configure or enable one");
    expect(latestConnectorStore().listAccounts).toHaveBeenCalledWith({
      source: "discord",
      status: "enabled",
    });
  });

  it("isolates all-enabled startup failures and runs accounts that can start", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    discordCliMocks.state.listAccountsResult = [
      discordCliMocks.makeAccount({accountKey: "ops"}),
      discordCliMocks.makeAccount({accountKey: "lab", connectorKey: "345678901234567890"}),
    ];
    const createRunService = vi.fn((options: {accountKey: string; dataDir: string}) => {
      const start = vi.fn(async () => {
        if (options.accountKey === "ops") {
          throw new Error("startup failed");
        }
      });
      return {
        start,
        run: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
    });

    await createProgram({createRunService}).parseAsync([
      "discord",
      "run",
      "--all-enabled",
    ], {from: "user"});

    expect(createRunService).toHaveBeenCalledTimes(2);
    const output = collectWrites(write);
    expect(output).toContain("worker_start_failed");
    expect(output).toContain("startup failed");
    expect(output).toContain("worker_supervisor_started");
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("fails all-enabled run when every enabled account fails startup", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    discordCliMocks.state.listAccountsResult = [
      discordCliMocks.makeAccount({accountKey: "ops"}),
      discordCliMocks.makeAccount({accountKey: "lab", connectorKey: "345678901234567890"}),
    ];

    await expect(createProgram({
      createRunService: () => ({
        start: vi.fn(async () => {
          throw new Error("startup failed");
        }),
        run: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      }),
    }).parseAsync([
      "discord",
      "run",
      "--all-enabled",
    ], {from: "user"})).rejects.toThrow("No Discord workers started. Every enabled Discord account failed during startup.");
  });

  it("stops all-enabled Discord workers concurrently on SIGTERM", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const handlers: Record<string, () => void> = {};
    vi.spyOn(process, "once").mockImplementation((event: string | symbol, listener: (...args: unknown[]) => void) => {
      handlers[String(event)] = () => listener();
      return process;
    });
    const off = vi.spyOn(process, "off").mockImplementation(() => process);
    discordCliMocks.state.listAccountsResult = [
      discordCliMocks.makeAccount({accountKey: "ops"}),
      discordCliMocks.makeAccount({accountKey: "lab", connectorKey: "345678901234567890"}),
    ];
    const runResolvers: Record<string, () => void> = {};
    const services: Record<string, {stop: ReturnType<typeof vi.fn>}> = {};
    const createRunService = vi.fn((options: {accountKey: string; dataDir: string}) => {
      const service = {
        start: vi.fn(async () => {
          if (options.accountKey === "lab") {
            setTimeout(() => handlers.SIGTERM?.(), 0);
          }
        }),
        run: vi.fn(async () => {
          await new Promise<void>((resolve) => {
            runResolvers[options.accountKey] = resolve;
          });
        }),
        stop: vi.fn(async () => {
          runResolvers[options.accountKey]?.();
        }),
      };
      services[options.accountKey] = service;
      return service;
    });

    await createProgram({createRunService}).parseAsync([
      "discord",
      "run",
      "--all-enabled",
    ], {from: "user"});

    expect(services.ops?.stop).toHaveBeenCalledOnce();
    expect(services.lab?.stop).toHaveBeenCalledOnce();
    expect(off).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(off).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
  });


  it("pairs a Discord actor to an identity using the selected account connector key", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "discord",
      "pair",
      "--account",
      "ops",
      "--identity",
      "patrik",
      "--actor",
      "234567890123456789",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(latestConnectorStore().ensureSchema).toHaveBeenCalledOnce();
    expect(latestIdentityStore().ensureSchema).toHaveBeenCalledOnce();
    expect(latestConnectorStore().getAccountByKey).toHaveBeenCalledWith("discord", "ops");
    expect(latestIdentityStore().getIdentityByHandle).toHaveBeenCalledWith("patrik");
    expect(latestIdentityStore().ensureIdentityBinding).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: discordCliMocks.botUser.id,
      externalActorId: "234567890123456789",
      identityId: "identity-patrik",
      metadata: {
        pairedVia: "discord-cli",
        accountKey: "ops",
      },
    });

    const output = collectWrites(write);
    expect(output).toContain("Paired Discord actor 234567890123456789.");
    expect(output).toContain("identity patrik");
    expect(output).toContain("identityId identity-patrik");
    expect(output).toContain("accountKey ops");
    expect(output).toContain(`connectorKey ${discordCliMocks.botUser.id}`);
    expect(output).toContain("actorId 234567890123456789");
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("infers the Discord account only when exactly one enabled account exists", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    discordCliMocks.state.listAccountsResult = [discordCliMocks.makeAccount({
      accountKey: "solo",
      connectorKey: "987654321098765432",
    })];

    await createProgram().parseAsync([
      "discord",
      "pair",
      "--identity",
      "patrik",
      "--actor",
      "234567890123456789",
    ], {from: "user"});

    expect(latestConnectorStore().listAccounts).toHaveBeenCalledWith({
      source: "discord",
      status: "enabled",
    });
    expect(latestConnectorStore().getAccountByKey).not.toHaveBeenCalled();
    expect(latestIdentityStore().ensureIdentityBinding).toHaveBeenCalledWith(expect.objectContaining({
      source: "discord",
      connectorKey: "987654321098765432",
      externalActorId: "234567890123456789",
      identityId: "identity-patrik",
      metadata: {
        pairedVia: "discord-cli",
        accountKey: "solo",
      },
    }));

    const output = collectWrites(write);
    expect(output).toContain("accountKey solo");
    expect(output).toContain("connectorKey 987654321098765432");
  });

  it("fails loudly when omitted Discord account cannot resolve to exactly one enabled account", async () => {
    discordCliMocks.state.listAccountsResult = [];

    await expect(createProgram().parseAsync([
      "discord",
      "pair",
      "--identity",
      "patrik",
      "--actor",
      "234567890123456789",
    ], {from: "user"})).rejects.toThrow("No enabled Discord accounts found");

    discordCliMocks.state.listAccountsResult = [
      discordCliMocks.makeAccount({accountKey: "ops"}),
      discordCliMocks.makeAccount({accountKey: "lab", connectorKey: "345678901234567890"}),
    ];

    await expect(createProgram().parseAsync([
      "discord",
      "pair",
      "--identity",
      "patrik",
      "--actor",
      "234567890123456789",
    ], {from: "user"})).rejects.toThrow("Multiple enabled Discord accounts found (ops, lab). Pass --account <accountKey> to choose one.");
  });

  it("rejects Discord usernames or display names as actor values before store writes", async () => {
    const program = createProgram();
    program.exitOverride();
    const errorWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(program.parseAsync([
      "discord",
      "pair",
      "--account",
      "ops",
      "--identity",
      "patrik",
      "--actor",
      "@patrik",
    ], {from: "user"})).rejects.toThrow("process.exit unexpectedly called");

    expect(collectWrites(errorWrite)).toContain(
      "Discord actor must be a numeric Discord user id/snowflake, not a username or display name.",
    );
    expect(discordCliMocks.connectorStoreInstances).toHaveLength(0);
    expect(discordCliMocks.identityStoreInstances).toHaveLength(0);
  });

  it("rejects wrong-source explicit accounts before identity binding", async () => {
    discordCliMocks.state.account = discordCliMocks.makeAccount({source: "slack"});

    await expect(createProgram().parseAsync([
      "discord",
      "pair",
      "--account",
      "ops",
      "--identity",
      "patrik",
      "--actor",
      "234567890123456789",
    ], {from: "user"})).rejects.toThrow("unsupported source slack");

    expect(latestIdentityStore().getIdentityByHandle).not.toHaveBeenCalled();
    expect(latestIdentityStore().ensureIdentityBinding).not.toHaveBeenCalled();
  });

  it("surfaces missing identity and existing different-identity pairing errors", async () => {
    discordCliMocks.state.getIdentityByHandleError = new Error("Unknown identity handle missing");

    await expect(createProgram().parseAsync([
      "discord",
      "pair",
      "--account",
      "ops",
      "--identity",
      "missing",
      "--actor",
      "234567890123456789",
    ], {from: "user"})).rejects.toThrow("Unknown identity handle missing");
    expect(latestIdentityStore().ensureIdentityBinding).not.toHaveBeenCalled();

    discordCliMocks.state.getIdentityByHandleError = null;
    discordCliMocks.state.ensureIdentityBindingError = new Error(
      "Identity binding discord/123456789012345678/234567890123456789 already belongs to identity identity-alice, not identity-patrik.",
    );

    await expect(createProgram().parseAsync([
      "discord",
      "pair",
      "--account",
      "ops",
      "--identity",
      "patrik",
      "--actor",
      "234567890123456789",
    ], {from: "user"})).rejects.toThrow("already belongs to identity identity-alice");
    expect(latestIdentityStore().ensureIdentityBinding).toHaveBeenCalledWith(expect.objectContaining({
      source: "discord",
      connectorKey: discordCliMocks.botUser.id,
      externalActorId: "234567890123456789",
      identityId: "identity-patrik",
    }));
  });

  it("requires enabled accounts for pair but allows disabled-account unpair cleanup and no-op reporting", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    discordCliMocks.state.account = discordCliMocks.makeAccount({status: "disabled"});

    await expect(createProgram().parseAsync([
      "discord",
      "pair",
      "--account",
      "ops",
      "--identity",
      "patrik",
      "--actor",
      "234567890123456789",
    ], {from: "user"})).rejects.toThrow("disabled");
    expect(latestIdentityStore().getIdentityByHandle).not.toHaveBeenCalled();

    await createProgram().parseAsync([
      "discord",
      "unpair",
      "--account",
      "ops",
      "--actor",
      "234567890123456789",
    ], {from: "user"});
    expect(latestIdentityStore().deleteIdentityBinding).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: discordCliMocks.botUser.id,
      externalActorId: "234567890123456789",
    });

    discordCliMocks.state.deleteIdentityBindingResult = false;
    await createProgram().parseAsync([
      "discord",
      "unpair",
      "--account",
      "ops",
      "--actor",
      "234567890123456789",
    ], {from: "user"});

    const output = collectWrites(write);
    expect(output).toContain("Unpaired Discord actor 234567890123456789.");
    expect(output).toContain("No Discord pairing found for actor 234567890123456789.");
    expect(output).toContain("accountKey ops");
    expect(output).toContain(`connectorKey ${discordCliMocks.botUser.id}`);
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("lists Discord actor pairings for an explicit account without leaking metadata", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    discordCliMocks.state.account = discordCliMocks.makeAccount({status: "disabled"});
    discordCliMocks.state.listIdentitiesResult = [
      discordCliMocks.makeIdentity({id: "identity-patrik", handle: "patrik"}),
      discordCliMocks.makeIdentity({id: "identity-alice", handle: "alice"}),
    ];
    discordCliMocks.state.listIdentityBindingsResult = {
      "identity-patrik": [
        discordCliMocks.makeIdentityBinding({
          identityId: "identity-patrik",
          externalActorId: "234567890123456789",
          metadata: {
            privateMetadataSentinel: discordCliMocks.privateMetadataSentinel,
          },
        }),
        discordCliMocks.makeIdentityBinding({
          identityId: "identity-patrik",
          source: "telegram",
          externalActorId: "999",
        }),
      ],
      "identity-alice": [discordCliMocks.makeIdentityBinding({
        identityId: "identity-alice",
        connectorKey: "other-bot",
        externalActorId: "888888888888888888",
      })],
    };

    await createProgram().parseAsync([
      "discord",
      "pairings",
      "--account",
      "ops",
    ], {from: "user"});

    expect(latestIdentityStore().listIdentities).toHaveBeenCalledOnce();
    expect(latestIdentityStore().listIdentityBindings).toHaveBeenCalledWith("identity-patrik");
    expect(latestIdentityStore().listIdentityBindings).toHaveBeenCalledWith("identity-alice");

    const output = collectWrites(write);
    expect(output).toContain("discord/ops/234567890123456789");
    expect(output).toContain("  identity patrik");
    expect(output).toContain("  identityId identity-patrik");
    expect(output).toContain(`  connectorKey ${discordCliMocks.botUser.id}`);
    expect(output).toContain("  actorId 234567890123456789");
    expect(output).not.toContain("actorId 999");
    expect(output).not.toContain("actorId 888888888888888888");
    expect(output).not.toContain(discordCliMocks.privateMetadataSentinel);
    expect(output).not.toContain(discordCliMocks.privateToken);
  });


  it("binds an enabled Discord account channel to a validated session with safe metadata", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "discord",
      "bind-channel",
      "--account",
      "ops",
      "--channel",
      "channel-1",
      "--session",
      "session-a",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(latestConnectorStore().ensureSchema).toHaveBeenCalledOnce();
    expect(latestSessionStore().ensureSchema).toHaveBeenCalledOnce();
    expect(latestConversationRepo().ensureSchema).toHaveBeenCalledOnce();
    expect(latestConnectorStore().getAccountByKey).toHaveBeenCalledWith("discord", "ops");
    expect(latestSessionStore().getSession).toHaveBeenCalledWith("session-a");
    expect(latestConversationRepo().getConversationBinding).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: discordCliMocks.botUser.id,
      externalConversationId: "channel-1",
    });
    expect(latestConversationRepo().createConversationBinding).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: discordCliMocks.botUser.id,
      externalConversationId: "channel-1",
      sessionId: "session-a",
      metadata: {
        boundVia: "discord-cli",
        accountKey: "ops",
        channelId: "channel-1",
      },
    });

    const output = collectWrites(write);
    expect(output).toContain("Bound Discord channel channel-1 to session session-a.");
    expect(output).toContain("accountKey ops");
    expect(output).toContain(`connectorKey ${discordCliMocks.botUser.id}`);
    expect(output).toContain("channelId channel-1");
    expect(output).toContain("sessionId session-a");
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("accepts readable session ids when binding Discord channels", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "discord",
      "bind-channel",
      "--account",
      "ops",
      "--channel",
      "channel-1",
      "--session",
      "panda:ops-inbox",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(latestSessionStore().getSession).toHaveBeenCalledWith("panda:ops-inbox");
    expect(latestConversationRepo().createConversationBinding).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "panda:ops-inbox",
    }));

    const output = collectWrites(write);
    expect(output).toContain("Bound Discord channel channel-1 to session panda:ops-inbox.");
    expect(output).toContain("sessionId panda:ops-inbox");
  });


  it("resolves session aliases when binding Discord channels with an agent scope", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "discord",
      "bind-channel",
      "--account",
      "ops",
      "--channel",
      "channel-1",
      "--session",
      "ops-inbox",
      "--agent",
      "panda",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(latestSessionStore().resolveSessionRef).toHaveBeenCalledWith({
      sessionRef: "ops-inbox",
      agentKey: "panda",
    });
    expect(latestConversationRepo().createConversationBinding).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-canonical",
    }));
    expect(collectWrites(write)).toContain("Bound Discord channel channel-1 to session session-canonical.");
  });

  it("treats same-session Discord channel binds as no-op success", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    discordCliMocks.state.binding = discordCliMocks.makeBinding({
      sessionId: "session-a",
      metadata: {
        privateMetadataSentinel: discordCliMocks.privateMetadataSentinel,
      },
    });

    await createProgram().parseAsync([
      "discord",
      "bind-channel",
      "--account",
      "ops",
      "--channel",
      "channel-1",
      "--session",
      "session-a",
    ], {from: "user"});

    expect(latestConversationRepo().createConversationBinding).not.toHaveBeenCalled();
    expect(latestConversationRepo().bindConversation).not.toHaveBeenCalled();
    const output = collectWrites(write);
    expect(output).toContain("already bound to session session-a");
    expect(output).not.toContain(discordCliMocks.privateMetadataSentinel);
  });

  it("rejects already-bound Discord channels unless force is used", async () => {
    discordCliMocks.state.binding = discordCliMocks.makeBinding({sessionId: "session-b"});

    await expect(createProgram().parseAsync([
      "discord",
      "bind-channel",
      "--account",
      "ops",
      "--channel",
      "channel-1",
      "--session",
      "session-a",
    ], {from: "user"})).rejects.toThrow("already_bound");

    expect(latestConversationRepo().bindConversation).not.toHaveBeenCalled();
  });

  it("force rebinds a Discord channel and prints only safe ids", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    discordCliMocks.state.binding = discordCliMocks.makeBinding({
      sessionId: "session-b",
      metadata: {
        privateMetadataSentinel: discordCliMocks.privateMetadataSentinel,
      },
    });

    await createProgram().parseAsync([
      "discord",
      "bind-channel",
      "--account",
      "ops",
      "--channel",
      "channel-1",
      "--session",
      "session-a",
      "--force",
    ], {from: "user"});

    expect(latestConversationRepo().bindConversation).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: discordCliMocks.botUser.id,
      externalConversationId: "channel-1",
      sessionId: "session-a",
      metadata: {
        boundVia: "discord-cli",
        accountKey: "ops",
        channelId: "channel-1",
      },
    });
    const output = collectWrites(write);
    expect(output).toContain("Rebound Discord channel channel-1 to session session-a.");
    expect(output).toContain("previousSessionId session-b");
    expect(output).toContain("sessionId session-a");
    expect(output).not.toContain(discordCliMocks.privateMetadataSentinel);
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("blocks binding disabled Discord accounts but still allows list and unbind cleanup", async () => {
    discordCliMocks.state.account = discordCliMocks.makeAccount({status: "disabled"});

    await expect(createProgram().parseAsync([
      "discord",
      "bind-channel",
      "--account",
      "ops",
      "--channel",
      "channel-1",
      "--session",
      "session-a",
    ], {from: "user"})).rejects.toThrow("disabled");
    expect(latestSessionStore().getSession).not.toHaveBeenCalled();

    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    discordCliMocks.state.listBindingsResult = [discordCliMocks.makeBinding({
      metadata: {
        boundVia: "discord-cli",
        accountKey: "ops",
        channelId: "channel-1",
        privateMetadataSentinel: discordCliMocks.privateMetadataSentinel,
      },
    })];
    discordCliMocks.state.deleteBindingResult = false;

    await createProgram().parseAsync([
      "discord",
      "bindings",
      "list",
      "--account",
      "ops",
    ], {from: "user"});
    expect(latestConversationRepo().listConversationBindings).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: discordCliMocks.botUser.id,
    });

    await createProgram().parseAsync([
      "discord",
      "unbind-channel",
      "--account",
      "ops",
      "--channel",
      "channel-1",
    ], {from: "user"});
    expect(latestConversationRepo().deleteConversationBinding).toHaveBeenCalledWith({
      source: "discord",
      connectorKey: discordCliMocks.botUser.id,
      externalConversationId: "channel-1",
    });

    const output = collectWrites(write);
    expect(output).toContain("discord/ops/channel-1");
    expect(output).toContain("  metadata boundVia discord-cli");
    expect(output).toContain("  metadata accountKey ops");
    expect(output).toContain("  metadata channelId channel-1");
    expect(output).toContain("No Discord channel binding for channel-1.");
    expect(output).not.toContain(discordCliMocks.privateMetadataSentinel);
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("sets an account from stdin, resolves owner identity, and prints only safe fields", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram({
      readBotTokenFromStdin: async () => discordCliMocks.privateToken,
    }).parseAsync([
      "discord",
      "account",
      "set",
      "ops",
      "--bot-token-stdin",
      "--owner-identity",
      "alice",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(latestConnectorStore().ensureSchema).toHaveBeenCalledOnce();
    expect(latestIdentityStore().getIdentityByHandle).toHaveBeenCalledWith("alice");
    expect(latestConnectorStore().upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      source: "discord",
      accountKey: "ops",
      connectorKey: discordCliMocks.botUser.id,
      ownerIdentityId: "identity-alice",
      externalAccountId: discordCliMocks.botUser.id,
      externalUsername: discordCliMocks.botUser.username,
    }));
    expect(latestConnectorStore().setSecret).toHaveBeenCalledWith(
      "account-1",
      DISCORD_BOT_TOKEN_SECRET_KEY,
      discordCliMocks.privateToken,
      discordCliMocks.crypto,
    );

    const output = collectWrites(write);
    expect(output).toContain("Stored Discord account ops.");
    expect(output).toContain("source discord");
    expect(output).toContain(`connectorKey ${discordCliMocks.botUser.id}`);
    expect(output).toContain("username panda-bot");
    expect(output).toContain("globalName Panda Bot");
    expect(output).toContain("status enabled");
    expect(output).not.toContain(discordCliMocks.privateToken);
    expect(output).not.toContain("value_ciphertext");
  });

  it("sets an account from stdin, resolves owner agent, and prints only safe fields", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram({
      readBotTokenFromStdin: async () => discordCliMocks.privateToken,
    }).parseAsync([
      "discord",
      "account",
      "set",
      "ops",
      "--bot-token-stdin",
      "--agent",
      "clawd",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(latestAgentStore().getAgent).toHaveBeenCalledWith("clawd");
    expect(latestIdentityStore().getIdentityByHandle).not.toHaveBeenCalled();
    expect(latestConnectorStore().upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      ownerAgentKey: "clawd",
    }));
    expect(latestConnectorStore().setSecret).toHaveBeenCalledWith(
      "account-1",
      DISCORD_BOT_TOKEN_SECRET_KEY,
      discordCliMocks.privateToken,
      discordCliMocks.crypto,
    );

    const output = collectWrites(write);
    expect(output).toContain("Stored Discord account ops.");
    expect(output).toContain("status enabled");
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("imports from an env key, resolves owner agent, and does not print env values or env key refs", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram({
      env: {DISCORD_TOKEN_FOR_TEST: discordCliMocks.privateToken},
    }).parseAsync([
      "discord",
      "account",
      "import-env",
      "ops",
      "--env-key",
      "DISCORD_TOKEN_FOR_TEST",
      "--agent",
      "clawd",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(latestAgentStore().getAgent).toHaveBeenCalledWith("clawd");
    expect(latestConnectorStore().upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      ownerAgentKey: "clawd",
    }));
    const output = collectWrites(write);
    expect(output).toContain("Imported Discord account ops.");
    expect(output).toContain("status enabled");
    expect(output).not.toContain(discordCliMocks.privateToken);
    expect(output).not.toContain("DISCORD_TOKEN_FOR_TEST");
  });

  it("validates a stored account with whoami and keeps decrypted token out of output", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await createProgram().parseAsync([
      "discord",
      "account",
      "whoami",
      "ops",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(latestConnectorStore().getAccountByKey).toHaveBeenCalledWith("discord", "ops");
    expect(latestConnectorStore().getSecret).toHaveBeenCalledWith(
      "account-1",
      DISCORD_BOT_TOKEN_SECRET_KEY,
      discordCliMocks.crypto,
    );
    const output = collectWrites(write);
    expect(output).toContain("Discord account ops.");
    expect(output).toContain(`externalAccountId ${discordCliMocks.botUser.id}`);
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("disables an account without requiring credential decryption", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    discordCliMocks.resolveCredentialCrypto.mockReturnValueOnce(null);

    await createProgram().parseAsync([
      "discord",
      "account",
      "disable",
      "ops",
      "--db-url",
      "postgres://discord-db",
    ], {from: "user"});

    expect(discordCliMocks.resolveCredentialCrypto).not.toHaveBeenCalled();
    expect(latestConnectorStore().disableAccount).toHaveBeenCalledWith("discord", "ops");
    const output = collectWrites(write);
    expect(output).toContain("Disabled Discord account ops.");
    expect(output).toContain("status disabled");
    expect(output).not.toContain(discordCliMocks.privateToken);
  });

  it("fails loudly for conflicting owners and missing env tokens without printing secrets", async () => {
    await expect(createProgram({
      readBotTokenFromStdin: async () => discordCliMocks.privateToken,
    }).parseAsync([
      "discord",
      "account",
      "set",
      "ops",
      "--bot-token-stdin",
      "--owner-identity",
      "alice",
      "--agent",
      "clawd",
    ], {from: "user"})).rejects.toThrow("Choose only one Discord account owner: --owner-identity or --agent.");

    await expect(createProgram({
      env: {},
    }).parseAsync([
      "discord",
      "account",
      "import-env",
      "ops",
      "--env-key",
      "DISCORD_TOKEN_FOR_TEST",
    ], {from: "user"})).rejects.toThrow("Discord bot token environment variable is not set or empty.");
  });

  it("rejects legacy --owner-agent for Discord account owner selection", async () => {
    const program = createProgram();
    program.exitOverride();
    const errorWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(program.parseAsync([
      "discord",
      "account",
      "set",
      "ops",
      "--bot-token-stdin",
      "--owner-agent",
      "clawd",
    ], {from: "user"})).rejects.toThrow("process.exit unexpectedly called");
    expect(collectWrites(errorWrite)).toContain("unknown option '--owner-agent'");

    errorWrite.mockClear();
    const importProgram = createProgram();
    importProgram.exitOverride();

    await expect(importProgram.parseAsync([
      "discord",
      "account",
      "import-env",
      "ops",
      "--env-key",
      "DISCORD_TOKEN_FOR_TEST",
      "--owner-agent",
      "clawd",
    ], {from: "user"})).rejects.toThrow("process.exit unexpectedly called");
    expect(collectWrites(errorWrite)).toContain("unknown option '--owner-agent'");
    expect(discordCliMocks.connectorStoreInstances).toHaveLength(0);
    expect(discordCliMocks.agentStoreInstances).toHaveLength(0);
    expect(discordCliMocks.identityStoreInstances).toHaveLength(0);
  });

  it("redacts token material from unsafe setup failure messages", async () => {
    await expect(createProgram({
      env: {DISCORD_TOKEN_FOR_TEST: discordCliMocks.privateToken},
      getCurrentUser: async () => {
        throw new Error(`Discord rejected ${discordCliMocks.privateToken} and 12345678`);
      },
    }).parseAsync([
      "discord",
      "account",
      "import-env",
      "ops",
      "--env-key",
      "DISCORD_TOKEN_FOR_TEST",
    ], {from: "user"})).rejects.toThrow("[redacted]");

    try {
      await createProgram({
        env: {DISCORD_TOKEN_FOR_TEST: discordCliMocks.privateToken},
        getCurrentUser: async () => {
          throw new Error(`Discord rejected ${discordCliMocks.privateToken} and 12345678`);
        },
      }).parseAsync([
        "discord",
        "account",
        "import-env",
        "ops",
        "--env-key",
        "DISCORD_TOKEN_FOR_TEST",
      ], {from: "user"});
      throw new Error("Expected import-env to fail.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(discordCliMocks.privateToken);
      expect(message).not.toContain("12345678");
    }
  });
});
