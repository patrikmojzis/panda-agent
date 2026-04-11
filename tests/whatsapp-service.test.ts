import {afterEach, describe, expect, it, vi} from "vitest";

import {WhatsAppService} from "../src/integrations/channels/whatsapp/service.js";

const whatsappServiceMocks = vi.hoisted(() => {
  const socket = {
    ev: {
      on: vi.fn(),
      off: vi.fn(),
    },
    end: vi.fn(),
    updateMediaMessage: vi.fn(),
    requestPairingCode: vi.fn(async () => "123-456"),
  };

  return {
    socket,
    downloadMediaMessage: vi.fn(async () => Buffer.from("media")),
    normalizeMessageContent: vi.fn((message) => message ?? undefined),
    makeWASocket: vi.fn(() => socket),
  };
});

vi.mock("baileys", () => ({
  addTransactionCapability: (value: unknown) => value,
  Browsers: {
    macOS: vi.fn(() => ["Panda"]),
  },
  DisconnectReason: {
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 408,
    restartRequired: 515,
    unavailableService: 503,
  },
  isJidBroadcast: (jid?: string) => Boolean(jid?.endsWith("@broadcast")),
  isJidGroup: (jid?: string) => Boolean(jid?.endsWith("@g.us")),
  isJidNewsletter: (jid?: string) => Boolean(jid?.endsWith("@newsletter")),
  isJidStatusBroadcast: (jid?: string) => jid === "status@broadcast",
  jidNormalizedUser: (jid: string) => jid,
  makeCacheableSignalKeyStore: (value: unknown) => value,
  makeWASocket: whatsappServiceMocks.makeWASocket,
}));

vi.mock("baileys/lib/Utils/messages.js", () => ({
  downloadMediaMessage: whatsappServiceMocks.downloadMediaMessage,
  normalizeMessageContent: whatsappServiceMocks.normalizeMessageContent,
}));

function createStores() {
  return {
    authStore: {},
    outboundDeliveries: {},
    channelActions: {},
    requests: {
      enqueueRequest: vi.fn(async () => ({
        id: "request-1",
      })),
    },
    mediaStore: {
      writeMedia: vi.fn(async (input: Record<string, unknown>) => ({
        id: "media-1",
        source: "whatsapp",
        connectorKey: input.connectorKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        localPath: "/tmp/media.bin",
        originalFilename: input.hintFilename ?? null,
        metadata: input.metadata,
        createdAt: 1,
      })),
    },
    pool: {
      end: vi.fn(async () => {}),
    },
  } as const;
}

function createPrivateMessage(overrides: Record<string, unknown> = {}) {
  return {
    key: {
      remoteJid: "123@s.whatsapp.net",
      participant: undefined,
      id: "msg-1",
      fromMe: false,
    },
    message: {
      conversation: "hello from whatsapp",
    },
    pushName: "Alice",
    ...overrides,
  };
}

describe("WhatsAppService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    whatsappServiceMocks.socket.ev.on.mockClear();
    whatsappServiceMocks.socket.ev.off.mockClear();
    whatsappServiceMocks.socket.end.mockClear();
    whatsappServiceMocks.socket.updateMediaMessage.mockClear();
    whatsappServiceMocks.socket.requestPairingCode.mockClear();
    whatsappServiceMocks.downloadMediaMessage.mockClear();
    whatsappServiceMocks.normalizeMessageContent.mockClear();
    whatsappServiceMocks.makeWASocket.mockClear();
  });

  it("starts workers only after acquiring the connector lock", async () => {
    const stores = createStores();
    const release = vi.fn(async () => {});
    const order: string[] = [];
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    (service as {pool?: unknown}).pool = stores.pool;
    vi.spyOn(service as never, "whoami").mockResolvedValue({
      connectorKey: "main",
      registered: true,
      accountId: "acct-1",
    });
    vi.spyOn(service as never, "ensureStores").mockResolvedValue(stores);
    vi.spyOn(service as never, "acquireConnectorLock").mockImplementation(async () => {
      order.push("lock");
      return {release};
    });
    vi.spyOn(service as never, "ensureOutboundWorker").mockReturnValue({
      start: vi.fn(async () => {
        order.push("outbound");
      }),
      stop: vi.fn(async () => {}),
    });
    vi.spyOn(service as never, "ensureActionWorker").mockReturnValue({
      start: vi.fn(async () => {
        order.push("action");
      }),
      stop: vi.fn(async () => {}),
    });
    vi.spyOn(service as never, "runSocketCycle").mockImplementation(async () => {
      order.push("cycle");
      return {reconnect: false};
    });

    await expect(service.run()).resolves.toBeUndefined();

    expect(order).toEqual(["lock", "outbound", "action", "cycle"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(stores.pool.end).toHaveBeenCalledTimes(1);
  });

  it("does not start workers when lock acquisition fails", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "whoami").mockResolvedValue({
      connectorKey: "main",
      registered: true,
      accountId: "acct-1",
    });
    vi.spyOn(service as never, "ensureStores").mockResolvedValue(stores);
    vi.spyOn(service as never, "acquireConnectorLock").mockRejectedValue(new Error("WhatsApp connector main is already running."));
    const ensureOutboundWorker = vi.spyOn(service as never, "ensureOutboundWorker");
    const ensureActionWorker = vi.spyOn(service as never, "ensureActionWorker");

    await expect(service.run()).rejects.toThrow("WhatsApp connector main is already running.");

    expect(ensureOutboundWorker).not.toHaveBeenCalled();
    expect(ensureActionWorker).not.toHaveBeenCalled();
  });

  it("releases the connector lock when worker startup fails", async () => {
    const stores = createStores();
    const release = vi.fn(async () => {});
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    (service as {pool?: unknown}).pool = stores.pool;
    vi.spyOn(service as never, "whoami").mockResolvedValue({
      connectorKey: "main",
      registered: true,
      accountId: "acct-1",
    });
    vi.spyOn(service as never, "ensureStores").mockResolvedValue(stores);
    vi.spyOn(service as never, "acquireConnectorLock").mockResolvedValue({release});
    vi.spyOn(service as never, "ensureOutboundWorker").mockReturnValue({
      start: vi.fn(async () => {
        throw new Error("worker bootstrap failed");
      }),
      stop: vi.fn(async () => {}),
    });

    await expect(service.run()).rejects.toThrow("worker bootstrap failed");

    expect(release).toHaveBeenCalledTimes(1);
    expect(stores.pool.end).toHaveBeenCalledTimes(1);
  });

  it("enqueues private notify messages for Panda", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage()],
    });

    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith({
      kind: "whatsapp_message",
      payload: {
        connectorKey: "main",
        externalConversationId: "123@s.whatsapp.net",
        externalActorId: "123@s.whatsapp.net",
        externalMessageId: "msg-1",
        remoteJid: "123@s.whatsapp.net",
        chatType: "private",
        text: "hello from whatsapp",
        pushName: "Alice",
        quotedMessageId: undefined,
        media: [],
      },
    });
  });

  it("drops group messages and ignores non-notify upserts", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    await (service as never).handleMessagesUpsert(stores, {
      type: "append",
      messages: [createPrivateMessage()],
    });
    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage({
        key: {
          remoteJid: "group@g.us",
          participant: "123@s.whatsapp.net",
          id: "msg-2",
          fromMe: false,
        },
      })],
    });

    expect(stores.requests.enqueueRequest).not.toHaveBeenCalled();
  });

  it("downloads image messages and includes media metadata in the request", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    (service as {socket?: unknown}).socket = whatsappServiceMocks.socket;

    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage({
        message: {
          imageMessage: {
            caption: "see screenshot",
            mimetype: "image/jpeg",
            fileLength: 128,
          },
        },
      })],
    });

    expect(whatsappServiceMocks.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(stores.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      source: "whatsapp",
      connectorKey: "main",
      mimeType: "image/jpeg",
      sizeBytes: 128,
    }));
    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: "whatsapp_message",
      payload: expect.objectContaining({
        text: "see screenshot",
        media: [expect.objectContaining({
          id: "media-1",
          mimeType: "image/jpeg",
          sizeBytes: 128,
        })],
      }),
    }));
  });
});
