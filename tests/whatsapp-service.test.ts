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
    fetchLatestWaWebVersion: vi.fn(async () => ({
      version: [2, 3000, 1038819500],
      isLatest: true,
    })),
    normalizeMessageContent: vi.fn((message) => message ?? undefined),
    makeWASocket: vi.fn(() => socket),
  };
});

vi.mock("baileys", () => ({
  addTransactionCapability: (value: unknown) => value,
  bytesToCrockford: vi.fn(() => "ABCDEFGH"),
  Browsers: {
    macOS: vi.fn(() => ["Panda"]),
    ubuntu: vi.fn(() => ["Panda"]),
  },
  DisconnectReason: {
    connectionClosed: 428,
    connectionLost: 408,
    timedOut: 408,
    restartRequired: 515,
    loggedOut: 401,
    unavailableService: 503,
  },
  isJidBroadcast: (jid?: string) => Boolean(jid?.endsWith("@broadcast")),
  isJidGroup: (jid?: string) => Boolean(jid?.endsWith("@g.us")),
  isJidNewsletter: (jid?: string) => Boolean(jid?.endsWith("@newsletter")),
  isJidStatusBroadcast: (jid?: string) => jid === "status@broadcast",
  jidNormalizedUser: (jid: string) => jid,
  fetchLatestWaWebVersion: whatsappServiceMocks.fetchLatestWaWebVersion,
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
    vi.useRealTimers();
    vi.restoreAllMocks();
    whatsappServiceMocks.socket.ev.on.mockClear();
    whatsappServiceMocks.socket.ev.off.mockClear();
    whatsappServiceMocks.socket.end.mockClear();
    whatsappServiceMocks.socket.updateMediaMessage.mockClear();
    whatsappServiceMocks.socket.requestPairingCode.mockReset();
    whatsappServiceMocks.socket.requestPairingCode.mockResolvedValue("123-456");
    whatsappServiceMocks.downloadMediaMessage.mockClear();
    whatsappServiceMocks.fetchLatestWaWebVersion.mockClear();
    whatsappServiceMocks.normalizeMessageContent.mockClear();
    whatsappServiceMocks.makeWASocket.mockClear();
    vi.unstubAllEnvs();
  });

  it("starts workers only after acquiring the connector lease", async () => {
    const stores = createStores();
    const release = vi.fn(async () => {});
    const closeListener = vi.fn(async () => {});
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
    vi.spyOn(service as never, "acquireConnectorLease").mockImplementation(async () => {
      order.push("lease");
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
    vi.spyOn(service as never, "startWorkerNotificationListener").mockImplementation(async () => {
      order.push("listener");
      return {close: closeListener};
    });
    vi.spyOn(service as never, "runSocketCycle").mockImplementation(async () => {
      order.push("cycle");
      return {reconnect: false};
    });

    await expect(service.run()).resolves.toBeUndefined();

    expect(order).toEqual(["lease", "outbound", "action", "listener", "cycle"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(closeListener).toHaveBeenCalledTimes(1);
    expect(stores.pool.end).toHaveBeenCalledTimes(1);
  });

  it("still releases the connector lease when shutdown cleanup fails early", async () => {
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
    vi.spyOn(service as never, "acquireConnectorLease").mockResolvedValue({release});
    vi.spyOn(service as never, "ensureOutboundWorker").mockReturnValue({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    });
    vi.spyOn(service as never, "ensureActionWorker").mockReturnValue({
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    });
    vi.spyOn(service as never, "startWorkerNotificationListener").mockResolvedValue({
      close: vi.fn(async () => {
        throw new Error("listener close failed");
      }),
    });
    vi.spyOn(service as never, "runSocketCycle").mockImplementation(async () => {
      await service.stop();
      return {reconnect: false};
    });

    await expect(service.run()).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledTimes(1);
    expect(stores.pool.end).toHaveBeenCalledTimes(1);
  });

  it("does not start workers when lease acquisition fails", async () => {
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
    vi.spyOn(service as never, "acquireConnectorLease").mockRejectedValue(new Error("WhatsApp connector main is already running."));
    const ensureOutboundWorker = vi.spyOn(service as never, "ensureOutboundWorker");
    const ensureActionWorker = vi.spyOn(service as never, "ensureActionWorker");

    await expect(service.run()).rejects.toThrow("WhatsApp connector main is already running.");

    expect(ensureOutboundWorker).not.toHaveBeenCalled();
    expect(ensureActionWorker).not.toHaveBeenCalled();
  });

  it("releases the connector lease when worker startup fails", async () => {
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
    vi.spyOn(service as never, "acquireConnectorLease").mockResolvedValue({release});
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

  it("uses a standard browser identity for WhatsApp sockets", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });
    const saveCreds = vi.fn(async () => {});

    vi.spyOn(service as never, "ensureAuthStore").mockResolvedValue({
      createAuthState: vi.fn(async () => ({
        state: {
          creds: {},
          keys: {},
        },
        saveCreds,
      })),
    });

    await (service as never).createSocket();

    expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledWith(expect.objectContaining({
      browser: ["Panda"],
    }));
    expect((await import("baileys")).Browsers.ubuntu).toHaveBeenCalledWith("Chrome");
    expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledWith(expect.objectContaining({
      version: [2, 3000, 1038819500],
    }));
  });

  it("does not treat unregistered WhatsApp creds as linked", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureAuthStore").mockResolvedValue({
      loadCreds: vi.fn(async () => ({
        registered: false,
        me: {
          id: "421944478544@s.whatsapp.net",
          name: "~",
        },
      })),
    });

    await expect(service.whoami()).resolves.toEqual({
      connectorKey: "main",
      registered: false,
      accountId: undefined,
      phoneNumber: undefined,
      name: undefined,
    });
  });

  it("uses an operator-pinned WhatsApp Web version when configured", async () => {
    vi.stubEnv("PANDA_WHATSAPP_VERSION", "2.3000.1035194821");

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureAuthStore").mockResolvedValue({
      createAuthState: vi.fn(async () => ({
        state: {
          creds: {},
          keys: {},
        },
        saveCreds: vi.fn(async () => {}),
      })),
    });

    await (service as never).createSocket();

    expect(whatsappServiceMocks.makeWASocket).toHaveBeenCalledWith(expect.objectContaining({
      version: [2, 3000, 1035194821],
    }));
    expect(whatsappServiceMocks.fetchLatestWaWebVersion).not.toHaveBeenCalled();
  });

  it("treats WhatsApp 405 closes as reconnectable", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });
    const saveCreds = vi.fn(async () => {});

    vi.spyOn(service as never, "createSocket").mockResolvedValue({
      authHandle: {saveCreds},
      socket: whatsappServiceMocks.socket,
    });
    (service as {socket?: unknown}).socket = whatsappServiceMocks.socket;

    const cycle = (service as never).runSocketCycle(createStores());
    await Promise.resolve();

    const connectionHandler = whatsappServiceMocks.socket.ev.on.mock.calls.find(([event]) => {
      return event === "connection.update";
    })?.[1];
    expect(connectionHandler).toBeTypeOf("function");

    connectionHandler({
      connection: "close",
      lastDisconnect: {
        error: {
          output: {
            statusCode: 405,
          },
        },
      },
    });

    await expect(cycle).resolves.toEqual({
      reconnect: true,
      reason: "405",
    });
    expect(whatsappServiceMocks.socket.end).toHaveBeenCalledTimes(1);
  });

  it("requests a WhatsApp pairing code only after the socket starts connecting", async () => {
    vi.useFakeTimers();

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });
    const authHandle = {
      state: {
        creds: {
          registered: true,
          me: {
            id: "421944478544@s.whatsapp.net",
          },
        },
        keys: {},
      },
      saveCreds: vi.fn(async () => {}),
      promoteTo: vi.fn(async () => {}),
    };
    const pairingCodes: string[] = [];

    vi.spyOn(service as never, "ensureAuthStore").mockResolvedValue({
      createTransientAuthState: () => authHandle,
    });
    vi.spyOn(service as never, "createSocket").mockResolvedValue({
      authHandle,
      socket: whatsappServiceMocks.socket,
    });
    (service as {socket?: unknown}).socket = whatsappServiceMocks.socket;

    const cycle = (service as never).runPairSocketCycle("421944478544", (code: string) => {
      pairingCodes.push(code);
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(whatsappServiceMocks.socket.requestPairingCode).not.toHaveBeenCalled();

    const connectionHandler = whatsappServiceMocks.socket.ev.on.mock.calls.find(([event]) => {
      return event === "connection.update";
    })?.[1];
    expect(connectionHandler).toBeTypeOf("function");

    connectionHandler({connection: "connecting"});

    expect(whatsappServiceMocks.socket.requestPairingCode).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_500);

    expect(whatsappServiceMocks.socket.requestPairingCode).toHaveBeenCalledWith("421944478544", undefined);
    expect(pairingCodes).toEqual(["123-456"]);

    connectionHandler({connection: "open"});

    await expect(cycle).resolves.toEqual({
      pairedIdentity: {
        connectorKey: "main",
        registered: true,
        accountId: "421944478544@s.whatsapp.net",
      },
    });
    expect(authHandle.promoteTo).toHaveBeenCalledWith("main");
    expect(whatsappServiceMocks.socket.end).toHaveBeenCalledTimes(1);
  });

  it("treats pairing-code request 428 errors as reconnectable", async () => {
    vi.useFakeTimers();

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    whatsappServiceMocks.socket.requestPairingCode.mockRejectedValue({
      output: {
        statusCode: 428,
      },
    });
    vi.spyOn(service as never, "ensureAuthStore").mockResolvedValue({
      createTransientAuthState: () => ({
        state: {
          creds: {},
          keys: {},
        },
        saveCreds: vi.fn(async () => {}),
        promoteTo: vi.fn(async () => {}),
      }),
    });
    vi.spyOn(service as never, "createSocket").mockResolvedValue({
      authHandle: {
        state: {
          creds: {},
          keys: {},
        },
        saveCreds: vi.fn(async () => {}),
      },
      socket: whatsappServiceMocks.socket,
    });
    (service as {socket?: unknown}).socket = whatsappServiceMocks.socket;

    const cycle = (service as never).runPairSocketCycle("421944478544");
    await Promise.resolve();
    await Promise.resolve();

    const connectionHandler = whatsappServiceMocks.socket.ev.on.mock.calls.find(([event]) => {
      return event === "connection.update";
    })?.[1];
    expect(connectionHandler).toBeTypeOf("function");

    connectionHandler({connection: "connecting"});
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(cycle).resolves.toEqual({
      reconnect: true,
      reason: "428",
    });
    expect(whatsappServiceMocks.socket.end).toHaveBeenCalledTimes(1);
  });

  it("treats WhatsApp 401 closes as retryable while linking", async () => {
    vi.useFakeTimers();

    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureAuthStore").mockResolvedValue({
      createTransientAuthState: () => ({
        state: {
          creds: {},
          keys: {},
        },
        saveCreds: vi.fn(async () => {}),
        promoteTo: vi.fn(async () => {}),
      }),
    });
    vi.spyOn(service as never, "createSocket").mockResolvedValue({
      authHandle: {
        state: {
          creds: {},
          keys: {},
        },
        saveCreds: vi.fn(async () => {}),
      },
      socket: whatsappServiceMocks.socket,
    });
    (service as {socket?: unknown}).socket = whatsappServiceMocks.socket;

    const cycle = (service as never).runPairSocketCycle("421944478544");
    await Promise.resolve();
    await Promise.resolve();

    const connectionHandler = whatsappServiceMocks.socket.ev.on.mock.calls.find(([event]) => {
      return event === "connection.update";
    })?.[1];
    expect(connectionHandler).toBeTypeOf("function");

    connectionHandler({
      connection: "close",
      lastDisconnect: {
        error: {
          output: {
            statusCode: 401,
          },
        },
      },
    });

    await expect(cycle).resolves.toEqual({
      reconnect: true,
      reason: "401",
    });
    expect(whatsappServiceMocks.socket.end).toHaveBeenCalledTimes(1);
  });

  it("promotes pairing auth when WhatsApp reports a new login before restart", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });
    const authHandle = {
      state: {
        creds: {
          registered: true,
          me: {
            id: "421944478544:1@s.whatsapp.net",
          },
        },
        keys: {},
      },
      saveCreds: vi.fn(async () => {}),
      promoteTo: vi.fn(async () => {}),
    };

    vi.spyOn(service as never, "ensureAuthStore").mockResolvedValue({
      createTransientAuthState: () => authHandle,
    });
    vi.spyOn(service as never, "createSocket").mockResolvedValue({
      authHandle,
      socket: whatsappServiceMocks.socket,
    });
    (service as {socket?: unknown}).socket = whatsappServiceMocks.socket;

    const cycle = (service as never).runPairSocketCycle("421944478544");
    await Promise.resolve();
    await Promise.resolve();

    const connectionHandler = whatsappServiceMocks.socket.ev.on.mock.calls.find(([event]) => {
      return event === "connection.update";
    })?.[1];
    expect(connectionHandler).toBeTypeOf("function");

    connectionHandler({isNewLogin: true});

    await expect(cycle).resolves.toEqual({
      pairedIdentity: {
        connectorKey: "main",
        registered: true,
        accountId: "421944478544:1@s.whatsapp.net",
      },
    });
    expect(authHandle.promoteTo).toHaveBeenCalledWith("main");
    expect(whatsappServiceMocks.socket.end).toHaveBeenCalledTimes(1);
  });

  it("reuses one WhatsApp pairing code across reconnects", async () => {
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });
    const pairingCodes: string[] = [];

    vi.spyOn(service as never, "ensureAuthStore").mockResolvedValue({
      loadCreds: vi.fn(async () => ({
        registered: false,
      })),
    });
    const runPairSocketCycle = vi.spyOn(service as never, "runPairSocketCycle")
      .mockImplementationOnce(async (_phoneNumber, onPairingCode, pairingCode) => {
        onPairingCode(pairingCode);
        return {reconnect: true, reason: "405"};
      })
      .mockImplementationOnce(async (_phoneNumber, onPairingCode, pairingCode) => {
        onPairingCode(pairingCode);
        return {
          pairedIdentity: {
            connectorKey: "main",
            registered: true,
            accountId: "421944478544@s.whatsapp.net",
          },
        };
      });

    await expect(service.pair("421944478544", (code) => pairingCodes.push(code))).resolves.toEqual({
      connectorKey: "main",
      registered: true,
      accountId: "421944478544@s.whatsapp.net",
      pairingCode: undefined,
      alreadyPaired: false,
    });

    expect(pairingCodes).toEqual(["ABCDEFGH"]);
    expect(runPairSocketCycle).toHaveBeenNthCalledWith(1, "421944478544", expect.any(Function), "ABCDEFGH");
    expect(runPairSocketCycle).toHaveBeenNthCalledWith(2, "421944478544", expect.any(Function), "ABCDEFGH");
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

  it("downloads voice-only audio messages and enqueues them as media", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    (service as {socket?: unknown}).socket = whatsappServiceMocks.socket;

    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage({
        key: {
          remoteJid: "123@s.whatsapp.net",
          participant: undefined,
          id: "msg-voice",
          fromMe: false,
        },
        message: {
          audioMessage: {
            fileLength: 321,
            ptt: true,
          },
        },
      })],
    });

    expect(whatsappServiceMocks.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(stores.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      source: "whatsapp",
      connectorKey: "main",
      mimeType: "audio/ogg",
      sizeBytes: 321,
      metadata: {
        whatsappMessageId: "msg-voice",
        whatsappRemoteJid: "123@s.whatsapp.net",
        whatsappMediaKind: "audio",
        ptt: true,
      },
    }));
    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: "whatsapp_message",
      payload: expect.objectContaining({
        text: "",
        media: [expect.objectContaining({
          id: "media-1",
          mimeType: "audio/ogg",
          sizeBytes: 321,
        })],
      }),
    }));
    expect(write.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("unsupported_message_shape");
  });

  it("preserves explicit WhatsApp audio MIME types", async () => {
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
          audioMessage: {
            mimetype: "audio/opus",
            fileLength: 456,
            ptt: false,
          },
        },
      })],
    });

    expect(stores.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: "audio/opus",
      sizeBytes: 456,
      metadata: expect.objectContaining({
        whatsappMediaKind: "audio",
        ptt: false,
      }),
    }));
    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        media: [expect.objectContaining({
          mimeType: "audio/opus",
          sizeBytes: 456,
        })],
      }),
    }));
  });

  it("downloads video-only messages and enqueues them as media", async () => {
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
          videoMessage: {
            fileLength: 1024,
          },
        },
      })],
    });

    expect(whatsappServiceMocks.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(stores.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      source: "whatsapp",
      connectorKey: "main",
      mimeType: "video/mp4",
      sizeBytes: 1024,
      metadata: expect.objectContaining({
        whatsappMediaKind: "video",
      }),
    }));
    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: "whatsapp_message",
      payload: expect.objectContaining({
        text: "",
        media: [expect.objectContaining({
          mimeType: "video/mp4",
          sizeBytes: 1024,
        })],
      }),
    }));
  });

  it("downloads sticker-only messages and enqueues them as media", async () => {
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
          stickerMessage: {
            fileLength: 256,
            isAnimated: true,
          },
        },
      })],
    });

    expect(whatsappServiceMocks.downloadMediaMessage).toHaveBeenCalledTimes(1);
    expect(stores.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
      mimeType: "image/webp",
      sizeBytes: 256,
      metadata: expect.objectContaining({
        whatsappMediaKind: "sticker",
        isAnimated: true,
      }),
    }));
    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: "whatsapp_message",
      payload: expect.objectContaining({
        media: [expect.objectContaining({
          mimeType: "image/webp",
          sizeBytes: 256,
        })],
      }),
    }));
  });

  it("enqueues contact-only messages as structured text", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage({
        message: {
          contactMessage: {
            displayName: "Alice Example",
            vcard: "BEGIN:VCARD\nFN:Alice Example\nTEL:+421900000000\nEND:VCARD",
          },
        },
      })],
    });

    expect(whatsappServiceMocks.downloadMediaMessage).not.toHaveBeenCalled();
    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: "whatsapp_message",
      payload: expect.objectContaining({
        media: [],
        text: expect.stringContaining("WhatsApp contact:"),
      }),
    }));
    const request = stores.requests.enqueueRequest.mock.calls[0]?.[0];
    expect(request?.payload.text).toContain("Alice Example");
    expect(request?.payload.text).toContain("BEGIN:VCARD");
  });

  it("enqueues contacts array messages as structured text", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage({
        message: {
          contactsArrayMessage: {
            contacts: [
              {
                displayName: "Alice",
                vcard: "BEGIN:VCARD\nFN:Alice\nEND:VCARD",
              },
              {
                displayName: "Bob",
                vcard: "BEGIN:VCARD\nFN:Bob\nEND:VCARD",
              },
            ],
          },
        },
      })],
    });

    const request = stores.requests.enqueueRequest.mock.calls[0]?.[0];
    expect(request?.payload.text).toContain("WhatsApp contact 1:");
    expect(request?.payload.text).toContain("Alice");
    expect(request?.payload.text).toContain("WhatsApp contact 2:");
    expect(request?.payload.text).toContain("Bob");
  });

  it("enqueues location-only messages as structured text with a map link", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage({
        message: {
          locationMessage: {
            name: "Office",
            address: "Main Street 1",
            degreesLatitude: 48.1486,
            degreesLongitude: 17.1077,
          },
        },
      })],
    });

    const request = stores.requests.enqueueRequest.mock.calls[0]?.[0];
    expect(request?.payload.text).toContain("WhatsApp location:");
    expect(request?.payload.text).toContain("Office");
    expect(request?.payload.text).toContain("https://maps.google.com/?q=48.1486,17.1077");
  });

  it("enqueues WhatsApp reactions separately from messages", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage({
        key: {
          remoteJid: "123@s.whatsapp.net",
          participant: undefined,
          id: "reaction-1",
          fromMe: false,
        },
        message: {
          reactionMessage: {
            text: "👍",
            key: {
              id: "target-1",
            },
          },
        },
      })],
    });

    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith({
      kind: "whatsapp_reaction",
      payload: expect.objectContaining({
        connectorKey: "main",
        externalConversationId: "123@s.whatsapp.net",
        externalActorId: "123@s.whatsapp.net",
        externalMessageId: "reaction-1",
        targetMessageId: "target-1",
        emoji: "👍",
      }),
    });
  });

  it("ignores WhatsApp reaction removals", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });

    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage({
        message: {
          reactionMessage: {
            text: "",
            key: {
              id: "target-1",
            },
          },
        },
      })],
    });

    expect(stores.requests.enqueueRequest).not.toHaveBeenCalled();
  });

  it("logs unsupported WhatsApp message shapes before dropping", async () => {
    const stores = createStores();
    const service = new WhatsAppService({
      connectorKey: "main",
      dataDir: "/tmp/panda",
    });
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await (service as never).handleMessagesUpsert(stores, {
      type: "notify",
      messages: [createPrivateMessage({
        message: {
          pollCreationMessage: {
            name: "Which one?",
          },
        },
      })],
    });

    expect(stores.requests.enqueueRequest).not.toHaveBeenCalled();
    const logs = write.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(logs).toContainEqual(expect.objectContaining({
      event: "message_dropped",
      reason: "unsupported_message_shape",
      messageShape: "pollCreationMessage",
    }));
  });
});
