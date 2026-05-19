import {afterEach, describe, expect, it, vi} from "vitest";

import type {AcquireManagedConnectorLeaseOptions} from "../src/domain/connector-leases/repo.js";
import type {ConnectorAccountRecord} from "../src/domain/connectors/types.js";
import type {CredentialCrypto} from "../src/domain/credentials/crypto.js";
import {
  DiscordService,
  type DiscordServiceDependencies,
  type DiscordWorkerStores,
} from "../src/integrations/channels/discord/service.js";

const privateToken = "discord-private-token-fragment-ABCDEFGH";
const connectorKey = "123456789012345678";

function collectWrites(write: {mock: {calls: unknown[][]}}): string {
  return write.mock.calls.map((call) => String(call[0])).join("");
}

function makeAccount(overrides: Partial<ConnectorAccountRecord> = {}): ConnectorAccountRecord {
  return {
    id: "account-1",
    source: "discord",
    accountKey: "ops",
    connectorKey,
    ownerKind: "system",
    ownerIdentityId: null,
    ownerAgentKey: null,
    displayName: "Panda Bot",
    externalAccountId: connectorKey,
    externalUsername: "panda-bot",
    status: "enabled",
    config: {},
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function createFixture(options: {
  account?: ConnectorAccountRecord | null;
  botUserId?: string;
  crypto?: CredentialCrypto | null;
  leaseAlreadyHeld?: boolean;
  poolMaxFallback?: number;
  secret?: string | null;
} = {}) {
  const order: string[] = [];
  let leaseOptions: AcquireManagedConnectorLeaseOptions | null = null;
  let gatewayOptions: Parameters<NonNullable<DiscordServiceDependencies["createGateway"]>>[0] | null = null;
  const account = options.account === undefined ? makeAccount() : options.account;
  const crypto = options.crypto === undefined ? ({kind: "crypto"} as unknown as CredentialCrypto) : options.crypto;
  const pool = {
    totalCount: 0,
    idleCount: 0,
    waitingCount: 0,
    connect: vi.fn(),
    query: vi.fn(),
    on: vi.fn(() => pool),
    off: vi.fn(() => pool),
    end: vi.fn(async () => {
      order.push("pool:end");
    }),
  };
  const connectorStore = {
    ensureSchema: vi.fn(async () => {
      order.push("schema:connector");
    }),
    getAccountByKey: vi.fn(async () => {
      order.push("account:get");
      return account;
    }),
    getSecret: vi.fn(async () => {
      order.push("secret:get");
      return options.secret === undefined ? privateToken : options.secret;
    }),
  };
  const sessionStore = {
    ensureSchema: vi.fn(async () => {
      order.push("schema:session");
    }),
  };
  const threadStore = {
    ensureSchema: vi.fn(async () => {
      order.push("schema:thread");
    }),
  };
  const conversationRepo = {
    ensureSchema: vi.fn(async () => {
      order.push("schema:conversation");
    }),
    getConversationBinding: vi.fn(),
  };
  const outboundDeliveries = {
    ensureSchema: vi.fn(async () => {
      order.push("schema:outbound");
    }),
  };
  const mediaStore = {
    writeMedia: vi.fn(async (input) => {
      order.push("media:write");
      return {
        id: "media-discord-1",
        source: input.source,
        connectorKey: input.connectorKey,
        mimeType: input.mimeType,
        sizeBytes: input.bytes.byteLength,
        localPath: "/tmp/discord-media.png",
        originalFilename: input.hintFilename,
        metadata: input.metadata,
        createdAt: 1,
      };
    }),
  };
  const runtimeRequests = {
    ensureSchema: vi.fn(async () => {
      order.push("schema:requests");
    }),
    enqueueRequest: vi.fn(async (input) => {
      order.push("request:enqueue");
      return {
        id: "request-discord-1",
        kind: input.kind,
        status: "pending",
        payload: input.payload,
        createdAt: 1,
        updatedAt: 1,
      };
    }),
  };
  const connectorLeases = {
    ensureSchema: vi.fn(async () => {
      order.push("schema:lease");
    }),
  };
  const stores = {
    connectorLeases,
    connectorStore,
    conversationRepo,
    outboundDeliveries,
    mediaStore,
    pool,
    runtimeRequests,
    sessionStore,
    threadStore,
  } as unknown as DiscordWorkerStores;
  const restClient = {
    createMessage: vi.fn(),
    getChannelMetadata: vi.fn(async () => ({
      id: "channel-1",
      type: 0,
      guildId: "guild-1",
    })),
    getCurrentUser: vi.fn(async (token: string) => {
      order.push("token:validate");
      if (token !== privateToken) {
        throw new Error(`unexpected token ${token}`);
      }
      return {
        id: options.botUserId ?? connectorKey,
        username: "panda-bot",
        displayName: "Panda Bot",
        bot: true,
      };
    }),
  };
  const lease = {
    release: vi.fn(async () => {
      order.push("lease:release");
    }),
  };
  const outboundWorker = {
    start: vi.fn(async () => {
      order.push("outbound:start");
    }),
    stop: vi.fn(async () => {
      order.push("outbound:stop");
    }),
  };
  const gateway = {
    start: vi.fn(async () => {
      order.push("gateway:start");
    }),
    stop: vi.fn(async () => {
      order.push("gateway:stop");
    }),
  };
  const dependencies: DiscordServiceDependencies = {
    acquireLease: vi.fn(async (input) => {
      order.push("lease:acquire");
      leaseOptions = input;
      if (options.leaseAlreadyHeld) {
        throw new Error(input.alreadyHeldMessage);
      }

      return lease;
    }),
    createGateway: vi.fn((input) => {
      order.push("gateway:create");
      gatewayOptions = input;
      return gateway;
    }),
    createOutboundWorker: vi.fn(() => {
      order.push("outbound:create");
      return outboundWorker;
    }),
    createPool: vi.fn(() => pool as never),
    createRestClient: vi.fn(() => restClient),
    createStores: vi.fn(() => stores),
    observePool: vi.fn(() => ({stop: vi.fn()})),
    resolveCrypto: vi.fn(() => crypto),
  };
  const service = new DiscordService({
    accountKey: "ops",
    dataDir: "/tmp/panda-media",
    dbUrl: "postgres://discord-db",
    dependencies,
    poolMaxFallback: options.poolMaxFallback,
  });

  return {
    connectorStore,
    conversationRepo,
    dependencies,
    gateway,
    get gatewayOptions() {
      return gatewayOptions;
    },
    get leaseOptions() {
      return leaseOptions;
    },
    lease,
    mediaStore,
    order,
    outboundWorker,
    pool,
    restClient,
    runtimeRequests,
    service,
  };
}

describe("DiscordService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the optional pool max fallback when the Discord pool env override is unset", async () => {
    const previousPoolMax = process.env.PANDA_DISCORD_DB_POOL_MAX;
    delete process.env.PANDA_DISCORD_DB_POOL_MAX;
    try {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const fixture = createFixture({poolMaxFallback: 2});

      await fixture.service.start();

      expect(fixture.dependencies.createPool).toHaveBeenCalledWith(expect.objectContaining({
        max: 2,
      }));
      await fixture.service.stop();
    } finally {
      if (previousPoolMax === undefined) {
        delete process.env.PANDA_DISCORD_DB_POOL_MAX;
      } else {
        process.env.PANDA_DISCORD_DB_POOL_MAX = previousPoolMax;
      }
    }
  });

  it("starts one enabled stored account, validates token identity, takes lease, starts outbound and Gateway, then stops safely", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fixture = createFixture();

    await fixture.service.start();

    expect(fixture.dependencies.createPool).toHaveBeenCalledWith(expect.objectContaining({
      accountKey: "ops",
      dbUrl: "postgres://discord-db",
      applicationName: "panda/discord/ops",
    }));
    expect(fixture.order).toEqual([
      "schema:connector",
      "schema:session",
      "schema:thread",
      "schema:conversation",
      "schema:outbound",
      "schema:requests",
      "schema:lease",
      "account:get",
      "secret:get",
      "token:validate",
      "lease:acquire",
      "outbound:create",
      "outbound:start",
      "gateway:create",
      "gateway:start",
    ]);
    expect(fixture.connectorStore.getAccountByKey).toHaveBeenCalledWith("discord", "ops");
    expect(fixture.connectorStore.getSecret).toHaveBeenCalledWith("account-1", "bot_token", expect.anything());
    expect(fixture.restClient.getCurrentUser).toHaveBeenCalledWith(privateToken);
    expect(fixture.leaseOptions).toMatchObject({
      source: "discord",
      connectorKey,
      alreadyHeldMessage: `Discord connector ${connectorKey} is already running.`,
    });
    expect(fixture.gatewayOptions).toMatchObject({
      accountKey: "ops",
      connectorKey,
    });

    fixture.order.length = 0;
    await fixture.service.stop();
    expect(fixture.order).toEqual([
      "gateway:stop",
      "outbound:stop",
      "lease:release",
      "pool:end",
    ]);
    const output = collectWrites(write);
    expect(output).toContain("worker_started");
    expect(output).not.toContain(privateToken);
    expect(output).not.toContain("ABCDEFGH");
  });

  it("enqueues bound Gateway messages as discord_message runtime requests by default", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fixture = createFixture();
    await fixture.service.start();
    fixture.order.length = 0;

    fixture.restClient.getChannelMetadata.mockResolvedValue({
      id: "channel-1",
      type: 0,
      guildId: "guild-1",
    });
    fixture.conversationRepo.getConversationBinding.mockResolvedValue({
      source: "discord",
      connectorKey,
      externalConversationId: "channel-1",
      sessionId: "session-1",
      createdAt: 1,
      updatedAt: 1,
    });

    await fixture.gatewayOptions?.onMessageCreate({
      id: "message-1",
      channel_id: "channel-1",
      guild_id: "guild-1",
      author: {
        id: "user-1",
        username: "patrik",
      },
      content: "PRIVATE_DISCORD_TEXT",
      attachments: [{
        id: "attachment-1",
        filename: "report.pdf",
        url: "https://cdn.example/private",
      }],
    });

    expect(fixture.runtimeRequests.enqueueRequest).toHaveBeenCalledWith({
      kind: "discord_message",
      payload: expect.objectContaining({
        connectorKey,
        externalConversationId: "channel-1",
        externalActorId: "user-1",
        externalMessageId: "message-1",
        actualChannelId: "channel-1",
        text: "PRIVATE_DISCORD_TEXT",
        authorUsername: "patrik",
        deliveryContext: {
          discord: {
            channelId: "channel-1",
            parentChannelId: "channel-1",
            guildId: "guild-1",
            messageId: "message-1",
          },
        },
        attachmentSummaries: [{
          id: "attachment-1",
          filename: "report.pdf",
        }],
      }),
    });
    expect(fixture.order).toEqual(["request:enqueue"]);
    const output = collectWrites(write);
    expect(output).toContain("message_queued");
    expect(output).toContain("request-discord-1");
    expect(output).not.toContain("PRIVATE_DISCORD_TEXT");
    expect(output).not.toContain("https://cdn.example/private");
    expect(output).not.toContain(privateToken);
  });

  it("downloads successful bound Gateway attachments into media storage before queueing", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fixture = createFixture();
    await fixture.service.start();
    fixture.order.length = 0;
    const attachmentUrl = "https://cdn.discordapp.com/attachments/channel/attachment/image.png?secret=1";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from("media"), {
      status: 200,
      headers: {"content-length": "5"},
    })));

    fixture.conversationRepo.getConversationBinding.mockResolvedValue({
      source: "discord",
      connectorKey,
      externalConversationId: "channel-1",
      sessionId: "session-1",
      createdAt: 1,
      updatedAt: 1,
    });

    await fixture.gatewayOptions?.onMessageCreate({
      id: "message-2",
      channel_id: "channel-1",
      guild_id: "guild-1",
      author: {
        id: "user-1",
      },
      content: "image attached",
      attachments: [{
        id: "attachment-2",
        filename: "image.png",
        content_type: "image/png",
        size: 5,
        url: attachmentUrl,
      }],
    });

    expect(fixture.order).toEqual(["media:write", "request:enqueue"]);
    expect(fixture.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      source: "discord",
      connectorKey,
      mimeType: "image/png",
      sizeBytes: 5,
      hintFilename: "image.png",
      metadata: {
        discordAttachmentId: "attachment-2",
      },
    }));
    expect(JSON.stringify(fixture.mediaStore.writeMedia.mock.calls[0]?.[0])).not.toContain(attachmentUrl);
    expect(fixture.runtimeRequests.enqueueRequest).toHaveBeenCalledWith({
      kind: "discord_message",
      payload: expect.objectContaining({
        externalMessageId: "message-2",
        attachmentSummaries: [{
          id: "attachment-2",
          filename: "image.png",
          contentType: "image/png",
          sizeBytes: 5,
        }],
        media: [expect.objectContaining({
          id: "media-discord-1",
          localPath: "/tmp/discord-media.png",
          metadata: {
            discordAttachmentId: "attachment-2",
          },
        })],
      }),
    });
    const output = collectWrites(write);
    expect(output).toContain("message_queued");
    expect(output).toContain('"mediaCount":1');
    expect(output).not.toContain(attachmentUrl);
    expect(output).not.toContain(privateToken);
  });

  it("rejects disabled accounts before token load, lease acquisition, outbound, or Gateway", async () => {
    const fixture = createFixture({
      account: makeAccount({status: "disabled"}),
    });

    await expect(fixture.service.start()).rejects.toThrow("Discord account ops is not enabled.");

    expect(fixture.connectorStore.getSecret).not.toHaveBeenCalled();
    expect(fixture.dependencies.acquireLease).not.toHaveBeenCalled();
    expect(fixture.outboundWorker.start).not.toHaveBeenCalled();
    expect(fixture.gateway.start).not.toHaveBeenCalled();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });

  it("fails safely for missing crypto, missing token, and mismatched token identity before worker startup", async () => {
    const noCrypto = createFixture({crypto: null});
    await expect(noCrypto.service.start()).rejects.toThrow("CREDENTIALS_MASTER_KEY is required for Discord worker.");
    expect(noCrypto.connectorStore.getSecret).not.toHaveBeenCalled();
    expect(noCrypto.dependencies.acquireLease).not.toHaveBeenCalled();

    const noToken = createFixture({secret: null});
    await expect(noToken.service.start()).rejects.toThrow("does not have a stored bot token");
    expect(noToken.dependencies.acquireLease).not.toHaveBeenCalled();

    const mismatched = createFixture({botUserId: "987654321098765432"});
    try {
      await mismatched.service.start();
      throw new Error("Expected service start to fail.");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("identity does not match");
      expect(message).not.toContain(privateToken);
      expect(message).not.toContain("ABCDEFGH");
    }
    expect(mismatched.dependencies.acquireLease).not.toHaveBeenCalled();
  });

  it("fails safely when the connector lease is already held", async () => {
    const fixture = createFixture({leaseAlreadyHeld: true});

    await expect(fixture.service.start()).rejects.toThrow(`Discord connector ${connectorKey} is already running.`);

    expect(fixture.outboundWorker.start).not.toHaveBeenCalled();
    expect(fixture.gateway.start).not.toHaveBeenCalled();
    expect(fixture.lease.release).not.toHaveBeenCalled();
    expect(fixture.pool.end).toHaveBeenCalledOnce();
  });

  it("stops Gateway and outbound when the connector lease is lost", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const fixture = createFixture();
    await fixture.service.start();
    fixture.order.length = 0;

    await fixture.leaseOptions?.onLeaseLost?.(new Error("lease lost"));

    expect(fixture.order).toEqual([
      "gateway:stop",
      "outbound:stop",
      "lease:release",
      "pool:end",
    ]);
    const output = collectWrites(write);
    expect(output).toContain("connector_lease_lost");
    expect(output).not.toContain(privateToken);
  });
});
