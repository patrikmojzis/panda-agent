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
    listBindingsResult: Record<string, unknown>[];
    sessionExists: boolean;
    storedSecret: string | null;
  } = {
    account: {},
    binding: null,
    deleteBindingResult: true,
    listBindingsResult: [],
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

  function resetFixtures(): void {
    state.account = makeAccount();
    state.binding = null;
    state.deleteBindingResult = true;
    state.listBindingsResult = [];
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
      return state.account;
    });
    readonly getAccountByKey = vi.fn(async (_source: string, _accountKey: string) => state.account);
    readonly disableAccount = vi.fn(async (_source: string, accountKey: string) => {
      state.account = makeAccount({
        accountKey,
        status: "disabled",
      });
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

    constructor(_options: unknown) {
      sessionStoreInstances.push(this);
    }
  }

  class MockPostgresIdentityStore {
    readonly getIdentityByHandle = vi.fn(async (handle: string) => ({
      id: `identity-${handle}`,
      handle,
      displayName: handle,
      status: "active",
      createdAt: 1,
      updatedAt: 2,
    }));

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
  createRunService?: (options: {accountKey: string; dbUrl?: string}) => {run(): Promise<void>; stop(): Promise<void>};
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
    discordCliMocks.resolveCredentialCrypto.mockClear();
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
      "--owner-agent",
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
      "--owner-agent",
      "clawd",
    ], {from: "user"})).rejects.toThrow("Choose only one Discord account owner");

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
