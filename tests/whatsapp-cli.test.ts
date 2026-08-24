import {afterEach, describe, expect, it, vi} from "vitest";

import {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {
  whatsappAccountCreateCommand,
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
    upsertAccount: vi.fn(async (input: Record<string, unknown>) => ({...account, ...input})),
  };
  const agents = {
    getAgent: vi.fn(async () => ({agentKey: "panda"})),
    listIdentityPairings: vi.fn(async () => [{agentKey: "panda", identityId: "identity-alice"}]),
  };
  const auth = {
    deleteAuthState: vi.fn(),
    ensureSchema: vi.fn(),
  };
  const identities = {
    deleteIdentityBinding: vi.fn(async () => true),
    ensureIdentityBinding: vi.fn(async (input: Record<string, unknown>) => ({id: "binding-1", ...input})),
    getIdentityByHandle: vi.fn(async () => ({id: "identity-alice", handle: "alice"})),
  };
  return {account, accounts, agents, auth, identities};
});

vi.mock("../src/lib/postgres-bootstrap.js", () => ({
  ensureSchemas: vi.fn(async () => {}),
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
vi.mock("../src/integrations/channels/whatsapp/auth-store.js", () => ({
  PostgresWhatsAppAuthStore: class { constructor() { return mocks.auth; } },
}));

function dependencies(service: Record<string, unknown> = {}): WhatsAppCliDependencies {
  return {
    crypto: new CredentialCrypto("whatsapp-cli-tests"),
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
      crypto: new CredentialCrypto("whatsapp-cli-tests"),
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
      crypto: new CredentialCrypto("whatsapp-cli-tests"),
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
