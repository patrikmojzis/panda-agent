import {afterEach, describe, expect, it, vi} from "vitest";

import {SecretCrypto} from "../src/domain/secrets/crypto.js";
import {
  whatsappAccountCreateCommand,
  whatsappAccountConfigureCallingCommand,
  whatsappAccountDisableCommand,
  whatsappAccountLinkCommand,
  whatsappAccountResetCommand,
  whatsappAccountWhoamiCommand,
  whatsappPairCommand,
  whatsappRunCommand,
  whatsappUnpairCommand,
  type WhatsAppCliDependencies,
} from "../src/integrations/channels/whatsapp/cli.js";

const mocks = vi.hoisted(() => {
  const account = {
    id: "11111111-1111-4111-8111-111111111111",
    source: "whatsapp",
    accountKey: "main",
    connectorKey: "11111111-1111-4111-8111-111111111111",
    ownerKind: "agent",
    ownerIdentityId: null,
    ownerAgentKey: "panda",
    status: "disabled",
    config: {},
    createdAt: 0,
    updatedAt: 0,
  } as const;
  const accounts = {
    clearAccountExternalIdentity: vi.fn(async () => account),
    disableAccount: vi.fn(async () => account),
    enableAccount: vi.fn(async () => ({...account, status: "enabled"})),
    getAccountByKey: vi.fn(async () => account),
    listAccounts: vi.fn(async () => []),
    setAccountExternalIdentity: vi.fn(async () => account),
    setSecret: vi.fn(async () => undefined),
    upsertAccount: vi.fn(async (input: Record<string, unknown>) => ({...account, ...input})),
  };
  const agents = {
    getAgent: vi.fn(async () => ({agentKey: "panda"})),
    listIdentityPairings: vi.fn(async () => [{agentKey: "panda", identityId: "identity-alice"}]),
  };
  const auth = {
    deleteAuthState: vi.fn(),
  };
  const identities = {
    deleteIdentityBinding: vi.fn(async () => true),
    ensureIdentityBinding: vi.fn(async (input: Record<string, unknown>) => ({id: "binding-1", ...input})),
    getIdentityByHandle: vi.fn(async () => ({id: "identity-alice", handle: "alice"})),
  };
  const sessions = {
    getMainSession: vi.fn(async () => ({id: "session-main", agentKey: "panda", kind: "main", currentThreadId: "thread-main", createdAt: 1, updatedAt: 1})),
  };
  const conversations = {bindConversation: vi.fn(async (input: Record<string, unknown>) => ({binding: input}))};
  return {account, accounts, agents, auth, identities, sessions, conversations};
});

vi.mock("../src/lib/postgres-database.js", () => ({
  withPostgresPool: vi.fn(async (_dbUrl: string | undefined, fn: (pool: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock("../src/domain/connectors/postgres.js", () => ({
  PostgresConnectorAccountStore: class { constructor() { return mocks.accounts; } },
}));
vi.mock("../src/domain/agents/postgres.js", () => ({
  PostgresAgentStore: class { constructor() { return mocks.agents; } },
}));
vi.mock("../src/domain/identity/postgres.js", () => ({
  PostgresIdentityStore: class { constructor() { return mocks.identities; } },
}));
vi.mock("../src/domain/sessions/postgres.js", () => ({
  PostgresSessionStore: class { constructor() { return mocks.sessions; } },
}));
vi.mock("../src/domain/sessions/conversations/repo.js", () => ({
  ConversationRepo: class { constructor() { return mocks.conversations; } },
}));
vi.mock("../src/integrations/channels/whatsapp/auth-store.js", () => ({
  PostgresWhatsAppAuthStore: class { constructor() { return mocks.auth; } },
}));

function dependencies(service: Record<string, unknown> = {}): WhatsAppCliDependencies {
  return {
    crypto: new SecretCrypto("whatsapp-cli-tests"),
    createDaemonRuntime: async () => ({
      pool: {},
      poolConfig: {applicationName: "panda/whatsapp", max: 2},
      notifications: {register: vi.fn()},
      getNotificationSnapshot: () => ({status: "listening", listening: true}),
      close: vi.fn(async () => {}),
    }) as never,
    createRunService: () => ({
      run: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      ...service,
    }) as never,
  };
}

describe("WhatsApp account CLI", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mocks.accounts.getAccountByKey.mockResolvedValue(mocks.account);
    mocks.identities.deleteIdentityBinding.mockResolvedValue(true);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("creates a disabled agent-owned account with an opaque connector key", async () => {
    mocks.accounts.getAccountByKey.mockResolvedValueOnce(null);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await whatsappAccountCreateCommand("main", {agent: "panda"}, dependencies());

    expect(mocks.accounts.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      source: "whatsapp",
      accountKey: "main",
      ownerAgentKey: "panda",
      status: "disabled",
    }));
    const input = mocks.accounts.upsertAccount.mock.calls[0]![0] as {id: string; connectorKey: string};
    expect(input.connectorKey).toBe(input.id);
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Created disabled WhatsApp account main"));
  });

  it("fails closed when CREDENTIALS_MASTER_KEY is missing", async () => {
    vi.stubEnv("CREDENTIALS_MASTER_KEY", "");

    await expect(whatsappAccountCreateCommand("main", {agent: "panda"}))
      .rejects.toThrow("CREDENTIALS_MASTER_KEY is required for WhatsApp accounts");
    expect(mocks.accounts.upsertAccount).not.toHaveBeenCalled();
  });

  it("links an account through the service's atomic auth promotion", async () => {
    const pair = vi.fn(async (_phone: string, onCode?: (code: string) => void) => {
      onCode?.("ABCD-EFGH");
      return {connectorKey: mocks.account.connectorKey, registered: true, accountId: "421900000000@lid", alreadyPaired: false};
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await whatsappAccountLinkCommand("main", {phone: "421900000000"}, dependencies({pair}));

    expect(write).toHaveBeenCalledWith(expect.stringContaining("pairing code ABCD-EFGH"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("Linked WhatsApp account main"));
  });

  it("configures Meta Calling from encrypted file-backed secrets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "panda-whatsapp-calling-"));
    const accessTokenFile = path.join(directory, "access-token");
    const appSecretFile = path.join(directory, "app-secret");
    const verifyTokenFile = path.join(directory, "verify-token");
    await Promise.all([
      writeFile(accessTokenFile, "access-token\n", "utf8"),
      writeFile(appSecretFile, "app-secret\n", "utf8"),
      writeFile(verifyTokenFile, "verify-token\n", "utf8"),
    ]);
    try {
      await whatsappAccountConfigureCallingCommand("main", {
        phoneNumberId: "123", wabaId: "456", graphVersion: "v23.0",
        accessTokenFile, appSecretFile, verifyTokenFile,
      }, dependencies());
    } finally { await rm(directory, {recursive: true, force: true}); }

    expect(mocks.accounts.setSecret).toHaveBeenCalledTimes(3);
    expect(mocks.accounts.setSecret.mock.calls.map((call) => call.slice(1, 3))).toEqual([
      ["meta_access_token", "access-token"],
      ["meta_app_secret", "app-secret"],
      ["meta_verify_token", "verify-token"],
    ]);
    expect(mocks.accounts.upsertAccount).toHaveBeenCalledWith(expect.objectContaining({
      status: "enabled",
      config: {mode: "meta_cloud", calling: {enabled: true, phoneNumberId: "123", wabaId: "456", graphVersion: "v23.0"}},
    }));
  });

  it("reports, disables, and resets the selected account", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const whoami = vi.fn(async () => ({
      connectorKey: mocks.account.connectorKey,
      registered: true,
      accountId: "246664333885442@lid",
    }));

    await whatsappAccountWhoamiCommand("main", {}, dependencies({whoami}));
    await whatsappAccountDisableCommand("main", {}, dependencies());
    await whatsappAccountResetCommand("main", {}, dependencies());

    expect(whoami).toHaveBeenCalledOnce();
    expect(mocks.accounts.disableAccount).toHaveBeenCalledWith("whatsapp", "main");
    expect(mocks.auth.deleteAuthState).toHaveBeenCalledWith(mocks.account.id);
    expect(mocks.accounts.clearAccountExternalIdentity).toHaveBeenCalledWith("whatsapp", "main");
    expect(write).toHaveBeenCalledWith(expect.stringContaining("provider 246664333885442@lid"));
  });

  it("runs a selected enabled account by immutable account identity", async () => {
    const enabled = {...mocks.account, status: "enabled" as const};
    mocks.accounts.getAccountByKey.mockResolvedValueOnce(enabled as never);
    const run = vi.fn(async () => {});

    await whatsappRunCommand("main", {}, dependencies({run}));

    expect(run).toHaveBeenCalledOnce();
  });

  it("shares one daemon runtime across all enabled WhatsApp accounts", async () => {
    const second = {...mocks.account, id: "22222222-2222-4222-8222-222222222222", accountKey: "ops", connectorKey: "22222222-2222-4222-8222-222222222222", status: "enabled" as const};
    mocks.accounts.listAccounts.mockResolvedValueOnce([
      {...mocks.account, status: "enabled" as const},
      second,
    ] as never);
    const runtime = {
      pool: {},
      poolConfig: {applicationName: "panda/whatsapp", max: 2},
      notifications: {register: vi.fn()},
      getNotificationSnapshot: () => ({status: "listening", listening: true}),
      close: vi.fn(async () => {}),
    } as never;
    const services: Array<{run: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>}> = [];
    const createRunService = vi.fn(() => {
      let finish!: () => void;
      const running = new Promise<void>((resolve) => { finish = resolve; });
      const service = {
        run: vi.fn(() => running),
        stop: vi.fn(async () => finish()),
      };
      services.push(service);
      return service;
    });
    const command = whatsappRunCommand(undefined, {allEnabled: true}, {
      crypto: new SecretCrypto("whatsapp-cli-tests"),
      createDaemonRuntime: async () => runtime,
      createRunService,
    });
    while (services.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
    process.emit("SIGTERM", "SIGTERM");
    await command;

    expect(createRunService.mock.calls[0]![0].runtime).toBe(runtime);
    expect(createRunService.mock.calls[1]![0].runtime).toBe(runtime);
    expect(services.every((service) => service.stop.mock.calls.length === 1)).toBe(true);
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("cancels WhatsApp startup when SIGTERM arrives during first worker creation", async () => {
    const second = {...mocks.account, id: "22222222-2222-4222-8222-222222222222", accountKey: "ops", connectorKey: "22222222-2222-4222-8222-222222222222", status: "enabled" as const};
    mocks.accounts.listAccounts.mockResolvedValueOnce([
      {...mocks.account, status: "enabled" as const},
      second,
    ] as never);
    const services: Array<{run: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>}> = [];
    const createRunService = vi.fn(() => {
      const service = {
        run: vi.fn(async () => {}),
        stop: vi.fn(async () => {}),
      };
      services.push(service);
      if (services.length === 1) process.emit("SIGTERM", "SIGTERM");
      return service;
    });

    await whatsappRunCommand(undefined, {allEnabled: true}, {
      crypto: new SecretCrypto("whatsapp-cli-tests"),
      createDaemonRuntime: async () => ({
        pool: {},
        poolConfig: {applicationName: "panda/whatsapp", max: 2},
        notifications: {register: vi.fn()},
        getNotificationSnapshot: () => ({status: "listening", listening: true}),
        close: vi.fn(async () => {}),
      }) as never,
      createRunService,
    });

    expect(createRunService).toHaveBeenCalledOnce();
    expect(services[0]?.run).not.toHaveBeenCalled();
    expect(services[0]?.stop).toHaveBeenCalledOnce();
  });

  it("pairs an exact WhatsApp LID through the owned account", async () => {
    await whatsappPairCommand({
      account: "main",
      actor: "246664333885442@lid",
      identity: "alice",
    }, dependencies());

    expect(mocks.identities.ensureIdentityBinding).toHaveBeenCalledWith(expect.objectContaining({
      source: "whatsapp",
      connectorKey: mocks.account.connectorKey,
      externalActorId: "246664333885442@lid",
      identityId: "identity-alice",
    }));
  });

  it("binds an authorized Meta caller to the owning agent's main session", async () => {
    mocks.accounts.getAccountByKey.mockResolvedValueOnce({...mocks.account, status: "enabled", config: {mode: "meta_cloud", calling: {enabled: true, phoneNumberId: "123", wabaId: "456", graphVersion: "v23.0"}}} as never);
    await whatsappPairCommand({account: "main", actor: "421911111111", identity: "alice"}, dependencies());
    expect(mocks.conversations.bindConversation).toHaveBeenCalledWith({
      source: "whatsapp",
      connectorKey: mocks.account.connectorKey,
      externalConversationId: "421911111111@s.whatsapp.net",
      sessionId: "session-main",
      metadata: {channelAuthorization: {identityId: "identity-alice", agentKey: "panda", actorBindingId: "binding-1"}},
    });
  });

  it("rejects an identity that is not paired to the account owner", async () => {
    mocks.agents.listIdentityPairings.mockResolvedValueOnce([]);
    await expect(whatsappPairCommand({
      account: "main",
      actor: "421911111111",
      identity: "alice",
    }, dependencies())).rejects.toThrow("is not paired to agent panda");
  });

  it("unpairs an actor from the selected account", async () => {
    await whatsappUnpairCommand({account: "main", actor: "421911111111"}, dependencies());
    expect(mocks.identities.deleteIdentityBinding).toHaveBeenCalledWith({
      source: "whatsapp",
      connectorKey: mocks.account.connectorKey,
      externalActorId: "421911111111@s.whatsapp.net",
    });
  });
});
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
