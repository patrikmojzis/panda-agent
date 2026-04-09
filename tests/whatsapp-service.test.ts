import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const whatsappServiceMocks = vi.hoisted(() => {
  const pools: Array<{
    end: ReturnType<typeof vi.fn>;
    connect: ReturnType<typeof vi.fn>;
    client: {
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
  }> = [];
  const authStores: MockPostgresWhatsAppAuthStore[] = [];
  const identityStores: MockPostgresIdentityStore[] = [];
  const runtimes: MockWhatsAppRuntimeServices[] = [];
  const sockets: MockSocket[] = [];
  const downloadMediaMessage = vi.fn(async () => Buffer.from("downloaded-media"));
  const normalizeMessageContent = vi.fn((content: unknown) => content);
  let currentIdentityBinding: { identityId: string } | null = null;
  let currentCreds = {
    registered: false,
    me: undefined as
      | {
        id: string;
        phoneNumber?: string;
        name?: string;
        notify?: string;
      }
      | undefined,
  };

  class MockSocket {
    readonly ev = new EventEmitter();
    readonly end = vi.fn((_error?: Error) => {});
    readonly requestPairingCode = vi.fn(async (phoneNumber: string) => {
      this.auth.creds.me = {
        id: `${phoneNumber}:12@s.whatsapp.net`,
        phoneNumber,
        name: "Panda",
      };
      this.auth.creds.registered = true;
      this.ev.emit("creds.update");
      this.ev.emit("connection.update", {
        connection: "open",
      });
      return "ABC-123";
    });

    constructor(readonly auth: MockAuthHandle["state"]) {
      sockets.push(this);
    }
  }

  interface MockAuthHandle {
    state: {
      creds: {
        registered: boolean;
        me?: {
          id: string;
          phoneNumber?: string;
          name?: string;
          notify?: string;
        };
      };
      keys: {
        get: ReturnType<typeof vi.fn>;
        set: ReturnType<typeof vi.fn>;
      };
    };
    saveCreds: ReturnType<typeof vi.fn>;
  }

  class MockPostgresWhatsAppAuthStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly loadCreds = vi.fn(async () => currentCreds);
    readonly createAuthState = vi.fn(async () => {
      const handle: MockAuthHandle = {
        state: {
          creds: {
            registered: currentCreds.registered,
            me: currentCreds.me,
          },
          keys: {
            get: vi.fn(async () => ({})),
            set: vi.fn(async () => {}),
          },
        },
        saveCreds: vi.fn(async () => {}),
      };
      return handle;
    });

    constructor(_options: unknown) {
      authStores.push(this);
    }
  }

  class MockPostgresIdentityStore {
    readonly ensureSchema = vi.fn(async () => {});
    readonly resolveIdentityBinding = vi.fn(async () => currentIdentityBinding);

    constructor(_options: unknown) {
      identityStores.push(this);
    }
  }

  interface MockWhatsAppRuntimeServices {
    close: ReturnType<typeof vi.fn>;
    resolveOrCreateHomeThread: ReturnType<typeof vi.fn>;
    coordinator: {
      submitInput: ReturnType<typeof vi.fn>;
    };
    homeThreads: {
      rememberLastRoute: ReturnType<typeof vi.fn>;
    };
    mediaStore: {
      writeMedia: ReturnType<typeof vi.fn>;
    };
  }

  function createMockRuntime(): MockWhatsAppRuntimeServices {
    const runtime: MockWhatsAppRuntimeServices = {
      close: vi.fn(async () => {}),
      resolveOrCreateHomeThread: vi.fn(async () => ({
        id: "thread-home",
        identityId: "identity-local",
        agentKey: "panda",
      })),
      coordinator: {
        submitInput: vi.fn(async () => {}),
      },
      homeThreads: {
        rememberLastRoute: vi.fn(async () => {}),
      },
      mediaStore: {
        writeMedia: vi.fn(async (input: {
          source: string;
          connectorKey: string;
          mimeType: string;
          sizeBytes?: number;
          hintFilename?: string;
          bytes: Uint8Array;
        }) => ({
          id: `media-${input.mimeType}`,
          source: input.source,
          connectorKey: input.connectorKey,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes ?? input.bytes.byteLength,
          localPath: `/tmp/${input.hintFilename ?? "media.bin"}`,
          originalFilename: input.hintFilename,
          createdAt: 0,
        })),
      },
    };
    runtimes.push(runtime);
    return runtime;
  }

  return {
    pools,
    authStores,
    identityStores,
    runtimes,
    sockets,
    setIdentityBinding: (value: typeof currentIdentityBinding) => {
      currentIdentityBinding = value;
    },
    setCreds: (value: typeof currentCreds) => {
      currentCreds = value;
    },
    createPandaPool: vi.fn(() => {
      const client = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes("pg_try_advisory_lock")) {
            return { rows: [{ acquired: true }] };
          }
          if (sql.includes("pg_advisory_unlock")) {
            return { rows: [{ pg_advisory_unlock: true }] };
          }
          return { rows: [] };
        }),
        release: vi.fn(() => {}),
      };
      const pool = {
        end: vi.fn(async () => {}),
        connect: vi.fn(async () => client),
        client,
      };
      pools.push(pool);
      return pool;
    }),
    requirePandaDatabaseUrl: vi.fn((dbUrl?: string) => dbUrl ?? "postgres://resolved-db"),
    MockPostgresWhatsAppAuthStore,
    MockPostgresIdentityStore,
    createWhatsAppRuntime: vi.fn(async () => createMockRuntime()),
    downloadMediaMessage,
    normalizeMessageContent,
    makeWASocket: vi.fn((config: { auth: MockAuthHandle["state"] }) => new MockSocket(config.auth as MockAuthHandle)),
    makeCacheableSignalKeyStore: vi.fn((keys: unknown) => keys),
    addTransactionCapability: vi.fn((keys: unknown) => keys),
    isJidBroadcast: vi.fn((jid: string | undefined) => Boolean(jid?.endsWith("@broadcast"))),
    isJidGroup: vi.fn((jid: string | undefined) => Boolean(jid?.endsWith("@g.us"))),
    isJidNewsletter: vi.fn((jid: string | undefined) => Boolean(jid?.endsWith("@newsletter"))),
    isJidStatusBroadcast: vi.fn((jid: string | undefined) => jid === "status@broadcast"),
    jidNormalizedUser: vi.fn((jid: string | undefined) => jid ?? ""),
    DisconnectReason: {
      connectionClosed: 428,
      connectionLost: 408,
      connectionReplaced: 440,
      timedOut: 408,
      loggedOut: 401,
      badSession: 500,
      restartRequired: 515,
      multideviceMismatch: 411,
      forbidden: 403,
      unavailableService: 503,
      428: "connectionClosed",
      408: "timedOut",
      440: "connectionReplaced",
      401: "loggedOut",
      500: "badSession",
      515: "restartRequired",
      411: "multideviceMismatch",
      403: "forbidden",
      503: "unavailableService",
    },
    Browsers: {
      macOS: vi.fn(() => ["Panda", "Safari", "1.0"]),
    },
  };
});

vi.mock("../src/features/panda/runtime.js", () => ({
  createPandaPool: whatsappServiceMocks.createPandaPool,
  requirePandaDatabaseUrl: whatsappServiceMocks.requirePandaDatabaseUrl,
}));

vi.mock("../src/features/whatsapp/auth-store.js", () => ({
  PostgresWhatsAppAuthStore: whatsappServiceMocks.MockPostgresWhatsAppAuthStore,
}));

vi.mock("../src/features/identity/index.js", () => ({
  PostgresIdentityStore: whatsappServiceMocks.MockPostgresIdentityStore,
}));

vi.mock("../src/features/whatsapp/runtime.js", () => ({
  createWhatsAppRuntime: whatsappServiceMocks.createWhatsAppRuntime,
}));

vi.mock("baileys", () => ({
  makeWASocket: whatsappServiceMocks.makeWASocket,
  makeCacheableSignalKeyStore: whatsappServiceMocks.makeCacheableSignalKeyStore,
  addTransactionCapability: whatsappServiceMocks.addTransactionCapability,
  isJidBroadcast: whatsappServiceMocks.isJidBroadcast,
  isJidGroup: whatsappServiceMocks.isJidGroup,
  isJidNewsletter: whatsappServiceMocks.isJidNewsletter,
  isJidStatusBroadcast: whatsappServiceMocks.isJidStatusBroadcast,
  jidNormalizedUser: whatsappServiceMocks.jidNormalizedUser,
  DisconnectReason: whatsappServiceMocks.DisconnectReason,
  Browsers: whatsappServiceMocks.Browsers,
}));

vi.mock("baileys/lib/Utils/messages.js", () => ({
  downloadMediaMessage: whatsappServiceMocks.downloadMediaMessage,
  normalizeMessageContent: whatsappServiceMocks.normalizeMessageContent,
}));

import { WhatsAppService } from "../src/features/whatsapp/service.js";

function latestAuthStore(): InstanceType<typeof whatsappServiceMocks.MockPostgresWhatsAppAuthStore> {
  const store = whatsappServiceMocks.authStores.at(-1);
  if (!store) {
    throw new Error("Expected a mocked WhatsApp auth store.");
  }

  return store;
}

function latestIdentityStore(): InstanceType<typeof whatsappServiceMocks.MockPostgresIdentityStore> {
  const store = whatsappServiceMocks.identityStores.at(-1);
  if (!store) {
    throw new Error("Expected a mocked WhatsApp identity store.");
  }

  return store;
}

function latestRuntime() {
  const runtime = whatsappServiceMocks.runtimes.at(-1);
  if (!runtime) {
    throw new Error("Expected a mocked WhatsApp runtime.");
  }

  return runtime;
}

describe("WhatsAppService", () => {
  afterEach(() => {
    whatsappServiceMocks.pools.length = 0;
    whatsappServiceMocks.authStores.length = 0;
    whatsappServiceMocks.identityStores.length = 0;
    whatsappServiceMocks.runtimes.length = 0;
    whatsappServiceMocks.sockets.length = 0;
    whatsappServiceMocks.setCreds({
      registered: false,
      me: undefined,
    });
    whatsappServiceMocks.setIdentityBinding(null);
    whatsappServiceMocks.createPandaPool.mockClear();
    whatsappServiceMocks.requirePandaDatabaseUrl.mockClear();
    whatsappServiceMocks.makeWASocket.mockClear();
    whatsappServiceMocks.createWhatsAppRuntime.mockClear();
    whatsappServiceMocks.downloadMediaMessage.mockClear();
    whatsappServiceMocks.normalizeMessageContent.mockClear();
    whatsappServiceMocks.makeCacheableSignalKeyStore.mockClear();
    whatsappServiceMocks.addTransactionCapability.mockClear();
    whatsappServiceMocks.isJidBroadcast.mockClear();
    whatsappServiceMocks.isJidGroup.mockClear();
    whatsappServiceMocks.isJidNewsletter.mockClear();
    whatsappServiceMocks.isJidStatusBroadcast.mockClear();
    whatsappServiceMocks.jidNormalizedUser.mockClear();
    whatsappServiceMocks.Browsers.macOS.mockClear();
    vi.useRealTimers();
  });

  it("reads linked account info from stored creds", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });

    await expect(service.whoami()).resolves.toEqual({
      connectorKey: "main",
      registered: true,
      accountId: "421900000000:12@s.whatsapp.net",
      phoneNumber: undefined,
      name: "Panda",
    });

    await service.stop();
  });

  it("requests a pairing code and waits for the linked account", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: false,
      me: undefined,
    });

    const seenCodes: string[] = [];
    const result = await service.pair("421900000000", (code) => {
      seenCodes.push(code);
    });

    expect(seenCodes).toEqual(["ABC-123"]);
    expect(result).toEqual({
      connectorKey: "main",
      registered: true,
      accountId: "421900000000:12@s.whatsapp.net",
      phoneNumber: "421900000000",
      name: "Panda",
      pairingCode: undefined,
      alreadyPaired: false,
    });
    expect(latestAuthStore().createAuthState).toHaveBeenCalledWith("main");
    expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(1);

    await service.stop();
  });

  it("short-circuits pair when the connector is already linked", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });

    await expect(service.pair("421900000000")).resolves.toEqual({
      connectorKey: "main",
      registered: true,
      accountId: "421900000000:12@s.whatsapp.net",
      phoneNumber: undefined,
      name: "Panda",
      alreadyPaired: true,
    });
    expect(whatsappServiceMocks.makeWASocket).not.toHaveBeenCalled();

    await service.stop();
  });

  it("fails fast when run is started before pairing", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: false,
      me: undefined,
    });

    await expect(service.run()).rejects.toThrow(
      "WhatsApp connector main is not paired yet. Run `panda whatsapp pair --phone <number>` first.",
    );
  });

  it("reconnects after a transient close and releases the connector lock on stop", async () => {
    vi.useFakeTimers();

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });

    const runPromise = service.run();
    await vi.waitFor(() => {
      expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(1);
    });

    const firstSocket = whatsappServiceMocks.sockets[0];
    firstSocket?.ev.emit("connection.update", {
      connection: "close",
      lastDisconnect: {
        error: {
          statusCode: whatsappServiceMocks.DisconnectReason.restartRequired,
          message: "restart",
        },
        date: new Date(),
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);

    await vi.waitFor(() => {
      expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(2);
    });

    const pool = whatsappServiceMocks.pools[0];
    await service.stop();
    await runPromise;

    expect(pool?.client.query).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock($1, $2) AS acquired",
      expect.any(Array),
    );
    expect(pool?.client.query).toHaveBeenCalledWith(
      "SELECT pg_advisory_unlock($1, $2)",
      expect.any(Array),
    );
    expect(pool?.client.release).toHaveBeenCalledTimes(1);
    expect(pool?.end).toHaveBeenCalledTimes(1);
  });

  it("drops unpaired private DMs before Panda sees them", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });

    await (service as unknown as { handleMessagesUpsert(update: unknown): Promise<void> }).handleMessagesUpsert({
      type: "notify",
      messages: [{
        key: {
          remoteJid: "421911111111@s.whatsapp.net",
          id: "msg-1",
          fromMe: false,
        },
        message: {
          conversation: "hello",
        },
      }],
    });

    const lines = write.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean);
    expect(lines.some((line) => line.includes("\"event\":\"message_dropped\"") && line.includes("\"reason\":\"unpaired_actor\""))).toBe(true);
    expect(latestIdentityStore().resolveIdentityBinding).toHaveBeenCalledWith({
      source: "whatsapp",
      connectorKey: "main",
      externalActorId: "421911111111@s.whatsapp.net",
    });
    expect(whatsappServiceMocks.createWhatsAppRuntime).not.toHaveBeenCalled();

    await service.stop();
  });

  it("drops group messages even if the sender is paired", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });

    const runPromise = service.run();
    await vi.waitFor(() => {
      expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(1);
    });

    whatsappServiceMocks.setIdentityBinding({
      identityId: "identity-local",
    });

    await (service as unknown as { handleMessagesUpsert(update: unknown): Promise<void> }).handleMessagesUpsert({
      type: "notify",
      messages: [{
        key: {
          remoteJid: "12345@g.us",
          participant: "421911111111@s.whatsapp.net",
          id: "msg-2",
          fromMe: false,
        },
        message: {
          conversation: "hello group",
        },
      }],
    });

    const lines = write.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean);
    expect(lines.some((line) => line.includes("\"event\":\"message_dropped\"") && line.includes("\"reason\":\"group_support_not_enabled\""))).toBe(true);
    if (whatsappServiceMocks.identityStores.length > 0) {
      expect(latestIdentityStore().resolveIdentityBinding).not.toHaveBeenCalled();
    }
    expect(whatsappServiceMocks.createWhatsAppRuntime).not.toHaveBeenCalled();

    await service.stop();
    await runPromise;
  });

  it("routes paired private DMs into the relationship home thread", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });

    const runPromise = service.run();
    await vi.waitFor(() => {
      expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(1);
    });

    whatsappServiceMocks.setIdentityBinding({
      identityId: "identity-local",
    });

    await (service as unknown as { handleMessagesUpsert(update: unknown): Promise<void> }).handleMessagesUpsert({
      type: "notify",
      messages: [{
        key: {
          remoteJid: "421911111111@s.whatsapp.net",
          id: "msg-3",
          fromMe: false,
        },
        message: {
          extendedTextMessage: {
            text: "hello panda",
            contextInfo: {
              stanzaId: "quoted-1",
            },
          },
        },
        pushName: "Patrik",
      }],
    });

    const runtime = latestRuntime();
    expect(runtime.resolveOrCreateHomeThread).toHaveBeenCalledWith({
      identityId: "identity-local",
      provider: undefined,
      model: undefined,
      context: {
        source: "whatsapp",
        remoteJid: "421911111111@s.whatsapp.net",
      },
    });
    expect(runtime.coordinator.submitInput).toHaveBeenCalledWith(
      "thread-home",
      expect.objectContaining({
        source: "whatsapp",
        channelId: "421911111111@s.whatsapp.net",
        externalMessageId: "msg-3",
        actorId: "421911111111@s.whatsapp.net",
        metadata: {
          route: {
            source: "whatsapp",
            connectorKey: "main",
            externalConversationId: "421911111111@s.whatsapp.net",
            externalActorId: "421911111111@s.whatsapp.net",
            externalMessageId: "msg-3",
          },
          whatsapp: {
            remoteJid: "421911111111@s.whatsapp.net",
            chatType: "private",
            messageId: "msg-3",
            pushName: "Patrik",
            quotedMessageId: "quoted-1",
            media: [],
          },
        },
      }),
    );
    expect(runtime.homeThreads.rememberLastRoute).toHaveBeenCalledWith({
      identityId: "identity-local",
      agentKey: "panda",
      route: {
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421911111111@s.whatsapp.net",
        externalActorId: "421911111111@s.whatsapp.net",
        externalMessageId: "msg-3",
        capturedAt: expect.any(Number),
      },
    });

    const lines = write.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean);
    expect(lines.some((line) => line.includes("\"event\":\"message_allowed\"") && line.includes("\"identityId\":\"identity-local\""))).toBe(true);
    expect(lines.some((line) => line.includes("\"event\":\"message_ingested\"") && line.includes("\"threadId\":\"thread-home\""))).toBe(true);

    await service.stop();
    await runPromise;
  });

  it("downloads image messages and ingests them with media metadata", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });
    whatsappServiceMocks.setIdentityBinding({
      identityId: "identity-local",
    });

    const runPromise = service.run();
    await vi.waitFor(() => {
      expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(1);
    });

    await (service as unknown as { handleMessagesUpsert(update: unknown): Promise<void> }).handleMessagesUpsert({
      type: "notify",
      messages: [{
        key: {
          remoteJid: "421911111111@s.whatsapp.net",
          id: "msg-image",
          fromMe: false,
        },
        message: {
          imageMessage: {
            mimetype: "image/jpeg",
            fileLength: 16,
          },
        },
        pushName: "Patrik",
      }],
    });

    const runtime = latestRuntime();
    expect(whatsappServiceMocks.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(runtime.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      source: "whatsapp",
      connectorKey: "main",
      mimeType: "image/jpeg",
      sizeBytes: 16,
    }));

    const submitPayload = runtime.coordinator.submitInput.mock.calls[0]?.[1];
    expect(submitPayload?.metadata).toMatchObject({
      whatsapp: {
        media: [
          expect.objectContaining({
            mimeType: "image/jpeg",
            localPath: "/tmp/media.bin",
          }),
        ],
      },
    });
    expect(JSON.stringify(submitPayload?.message)).toContain("/tmp/media.bin");

    await service.stop();
    await runPromise;
  });

  it("downloads document messages and preserves filename metadata", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });
    whatsappServiceMocks.setIdentityBinding({
      identityId: "identity-local",
    });

    const runPromise = service.run();
    await vi.waitFor(() => {
      expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(1);
    });

    await (service as unknown as { handleMessagesUpsert(update: unknown): Promise<void> }).handleMessagesUpsert({
      type: "notify",
      messages: [{
        key: {
          remoteJid: "421911111111@s.whatsapp.net",
          id: "msg-document",
          fromMe: false,
        },
        message: {
          documentMessage: {
            mimetype: "application/pdf",
            fileLength: 32,
            fileName: "report.pdf",
            caption: "check this",
          },
        },
      }],
    });

    const runtime = latestRuntime();
    expect(runtime.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: "application/pdf",
      sizeBytes: 32,
      hintFilename: "report.pdf",
    }));

    const submitPayload = runtime.coordinator.submitInput.mock.calls[0]?.[1];
    expect(submitPayload?.metadata).toMatchObject({
      whatsapp: {
        media: [
          expect.objectContaining({
            mimeType: "application/pdf",
            originalFilename: "report.pdf",
            localPath: "/tmp/report.pdf",
          }),
        ],
      },
    });
    expect(JSON.stringify(submitPayload?.message)).toContain("/tmp/report.pdf");

    await service.stop();
    await runPromise;
  });

  it("ignores non-notify upserts and history sync", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });

    const runPromise = service.run();
    await vi.waitFor(() => {
      expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(1);
    });

    const socket = whatsappServiceMocks.sockets[0];
    await vi.waitFor(() => {
      expect(socket?.ev.listenerCount("messages.upsert")).toBeGreaterThan(0);
      expect(socket?.ev.listenerCount("messaging-history.set")).toBeGreaterThan(0);
    });
    socket?.ev.emit("messages.upsert", {
      type: "append",
      messages: [],
    });
    socket?.ev.emit("messaging-history.set", {
      chats: [],
      contacts: [],
      messages: [],
      isLatest: true,
      syncType: null,
    });

    await vi.waitFor(() => {
      const lines = write.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean);
      expect(lines.some((line) => line.includes("\"event\":\"message_ignored\"") && line.includes("\"reason\":\"non_notify_upsert\""))).toBe(true);
      expect(lines.some((line) => line.includes("\"event\":\"history_sync_ignored\""))).toBe(true);
    });

    await service.stop();
    await runPromise;
  });

  it("reconnects after an upsert processing failure instead of silently continuing", async () => {
    vi.useFakeTimers();
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
      cwd: "/tmp/panda",
      locale: "en-US",
      timezone: "UTC",
      dbUrl: "postgres://wa-db",
    });

    whatsappServiceMocks.setCreds({
      registered: true,
      me: {
        id: "421900000000:12@s.whatsapp.net",
        name: "Panda",
      },
    });
    whatsappServiceMocks.setIdentityBinding({
      identityId: "identity-local",
    });
    whatsappServiceMocks.createWhatsAppRuntime.mockResolvedValueOnce({
      close: vi.fn(async () => {}),
      resolveOrCreateHomeThread: vi.fn(async () => ({
        id: "thread-home",
        identityId: "identity-local",
        agentKey: "panda",
      })),
      coordinator: {
        submitInput: vi.fn(async () => {
          throw new Error("submit exploded");
        }),
      },
      homeThreads: {
        rememberLastRoute: vi.fn(async () => {}),
      },
      mediaStore: {
        writeMedia: vi.fn(async () => ({
          id: "media-1",
          source: "whatsapp",
          connectorKey: "main",
          mimeType: "image/jpeg",
          sizeBytes: 0,
          localPath: "/tmp/media.bin",
          createdAt: 0,
        })),
      },
    });

    const runPromise = service.run();
    await vi.waitFor(() => {
      expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(1);
    });

    const firstSocket = whatsappServiceMocks.sockets[0];
    firstSocket?.ev.emit("messages.upsert", {
      type: "notify",
      messages: [{
        key: {
          remoteJid: "421911111111@s.whatsapp.net",
          id: "msg-fail",
          fromMe: false,
        },
        message: {
          conversation: "hello panda",
        },
      }],
    });

    await vi.waitFor(() => {
      expect(whatsappServiceMocks.createWhatsAppRuntime).toHaveBeenCalledTimes(1);
      const lines = write.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean);
      expect(lines.some((line) => line.includes("\"event\":\"upsert_error\"") && line.includes("submit exploded"))).toBe(true);
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledTimes(2);
    });

    await service.stop();
    await runPromise;
  });
});
