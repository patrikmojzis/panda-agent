import {afterEach, describe, expect, it, vi} from "vitest";

import {TelegramService} from "../src/integrations/channels/telegram/service.js";

const telegramServiceMocks = vi.hoisted(() => {
  const botInstances: MockBot[] = [];

  class MockBot {
    readonly api = {
      getMe: vi.fn(async () => ({
        id: 42,
        username: "panda_bot",
      })),
      setMyCommands: vi.fn(async () => {}),
      getUpdates: vi.fn(async () => []),
      getFile: vi.fn(async () => ({
        file_path: "documents/file.zip",
      })),
      setMessageReaction: vi.fn(async () => {}),
    };
    readonly on = vi.fn((event: string, handler: (ctx: unknown) => Promise<void> | void) => {
      this.handlers.set(event, handler);
      return this;
    });
    readonly handleUpdate = vi.fn(async (update: {context?: unknown}) => {
      const context = update.context;
      const event = context && typeof context === "object" && "messageReaction" in context
        ? "message_reaction"
        : "message";
      const handler = this.handlers.get(event);
      if (!handler) {
        return;
      }

      await handler(context);
    });
    botInfo?: unknown;
    private readonly handlers = new Map<string, (ctx: unknown) => Promise<void> | void>();

    constructor(_token: string) {
      botInstances.push(this);
    }
  }

  return {
    MockBot,
    botInstances,
  };
});

vi.mock("grammy", () => ({
  Bot: telegramServiceMocks.MockBot,
}));

function latestBot(): InstanceType<typeof telegramServiceMocks.MockBot> {
  const bot = telegramServiceMocks.botInstances.at(-1);
  if (!bot) {
    throw new Error("Expected a mocked Telegram bot instance.");
  }

  return bot;
}

function asArrayBuffer(value: string): ArrayBuffer {
  const buffer = Buffer.from(value, "utf8");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function stubTelegramFileDownload(bytes = "media"): void {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => asArrayBuffer(bytes),
  })));
}

function createStores() {
  return {
    pool: {
      end: vi.fn(async () => {}),
    },
    channelCursors: {
      resolveChannelCursor: vi.fn(async () => null),
      upsertChannelCursor: vi.fn(async () => ({
        source: "telegram",
        connectorKey: "42",
        cursorKey: "telegram-updates",
        value: "1",
      })),
    },
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
        source: input.source,
        connectorKey: input.connectorKey,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes ?? 5,
        localPath: "/tmp/media.bin",
        originalFilename: input.hintFilename,
        metadata: input.metadata,
        createdAt: 0,
      })),
    },
  } as const;
}

function createInitializedService(stores = createStores()): TelegramService {
  const service = new TelegramService({
    token: "telegram-token",
    dataDir: "/tmp/panda",
  });

  (service as {connectorKey?: string}).connectorKey = "42";
  vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
    stores,
    connectorKey: "42",
    botUsername: "panda_bot",
  });

  return service;
}

function createTelegramContext() {
  return {
    chat: {
      id: 777,
      type: "private",
    },
    from: {
      id: 123,
      username: "alice",
      first_name: "Alice",
      last_name: "Liddell",
    },
    msg: {
      message_id: 555,
      text: "show me the bug",
      chat: {
        id: 777,
      },
    },
  };
}

function createTelegramReactionContext(overrides: Record<string, unknown> = {}) {
  return {
    update: {
      update_id: 777001,
    },
    messageReaction: {
      chat: {
        id: 777,
        type: "private",
      },
      message_id: 555,
      user: {
        id: 123,
        username: "alice",
        first_name: "Alice",
        last_name: "Liddell",
        is_bot: false,
      },
      old_reaction: [],
      new_reaction: [{type: "emoji", emoji: "🔥"}],
    },
    ...overrides,
  };
}

describe("TelegramService", () => {
  afterEach(() => {
    vi.useRealTimers();
    telegramServiceMocks.botInstances.length = 0;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts workers only after acquiring the connector lease", async () => {
    const stores = createStores();
    const outboundWorker = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const actionWorker = {
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const release = vi.fn(async () => {});
    const closeListener = vi.fn(async () => {});
    const order: string[] = [];
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockImplementation(async () => {
      (service as {stores?: unknown}).stores = stores;
      return {
        stores,
        connectorKey: "42",
        botUsername: "panda_bot",
      };
    });
    vi.spyOn(service as never, "acquireConnectorLease").mockImplementation(async () => {
      order.push("lease");
      return {release};
    });
    vi.spyOn(service as never, "ensureOutboundWorker").mockReturnValue({
      ...outboundWorker,
      start: vi.fn(async () => {
        order.push("outbound");
      }),
    });
    vi.spyOn(service as never, "ensureActionWorker").mockReturnValue({
      ...actionWorker,
      start: vi.fn(async () => {
        order.push("action");
      }),
    });
    vi.spyOn(service as never, "startWorkerNotificationListener").mockImplementation(async () => {
      order.push("listener");
      return {close: closeListener};
    });

    const bot = latestBot();
    bot.api.setMyCommands.mockImplementationOnce(async () => {
      order.push("commands");
    });
    bot.api.getUpdates.mockImplementationOnce(async () => {
      order.push("poll");
      await service.stop();
      return [];
    });

    await expect(service.run()).resolves.toBeUndefined();

    expect(order).toEqual(["lease", "outbound", "action", "listener", "commands", "poll"]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(closeListener).toHaveBeenCalledTimes(1);
    expect(stores.pool.end).toHaveBeenCalledTimes(1);
  });

  it("still releases the connector lease when shutdown cleanup fails early", async () => {
    const stores = createStores();
    const release = vi.fn(async () => {});
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockImplementation(async () => {
      (service as {stores?: unknown}).stores = stores;
      return {
        stores,
        connectorKey: "42",
        botUsername: "panda_bot",
      };
    });
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

    const bot = latestBot();
    bot.api.getUpdates.mockImplementationOnce(async () => {
      await service.stop();
      return [];
    });

    await expect(service.run()).resolves.toBeUndefined();

    expect(release).toHaveBeenCalledTimes(1);
    expect(stores.pool.end).toHaveBeenCalledTimes(1);
  });

  it("does not start workers when lease acquisition fails", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });
    vi.spyOn(service as never, "acquireConnectorLease").mockRejectedValue(new Error("Telegram connector 42 is already running."));
    const ensureOutboundWorker = vi.spyOn(service as never, "ensureOutboundWorker");
    const ensureActionWorker = vi.spyOn(service as never, "ensureActionWorker");

    await expect(service.run()).rejects.toThrow("Telegram connector 42 is already running.");

    expect(ensureOutboundWorker).not.toHaveBeenCalled();
    expect(ensureActionWorker).not.toHaveBeenCalled();
  });

  it("releases the connector lease when worker startup fails", async () => {
    const stores = createStores();
    const release = vi.fn(async () => {});
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockImplementation(async () => {
      (service as {stores?: unknown}).stores = stores;
      return {
        stores,
        connectorKey: "42",
        botUsername: "panda_bot",
      };
    });
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

  it("enqueues telegram message requests with the normalized payload", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });
    vi.spyOn(service as never, "downloadSupportedMedia").mockResolvedValue({
      media: [],
      unavailable: [],
    });

    await (service as never).handleMessage(createTelegramContext());

    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith({
      kind: "telegram_message",
      payload: {
        connectorKey: "42",
        botUsername: "panda_bot",
        externalConversationId: "777",
        chatId: "777",
        chatType: "private",
        externalActorId: "123",
        externalMessageId: "555",
        text: "show me the bug",
        username: "alice",
        firstName: "Alice",
        lastName: "Liddell",
        replyToMessageId: undefined,
        media: [],
      },
    });
  });

  it("turns oversized Telegram documents into an inbound unavailable-attachment notice", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });

    const bot = latestBot();
    await (service as never).handleMessage({
      ...createTelegramContext(),
      msg: {
        message_id: 556,
        chat: {
          id: 777,
        },
        document: {
          file_id: "big-file",
          file_name: "archive.zip",
          mime_type: "application/zip",
          file_size: 35 * 1024 * 1024,
        },
      },
    });

    expect(bot.api.getFile).not.toHaveBeenCalled();
    expect(stores.requests.enqueueRequest).toHaveBeenCalledTimes(1);
    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith({
      kind: "telegram_message",
      payload: expect.objectContaining({
        externalMessageId: "556",
        media: [],
        text: expect.stringContaining("Telegram attachment unavailable:"),
      }),
    });
    const request = stores.requests.enqueueRequest.mock.calls[0]?.[0];
    expect(request?.payload.text).toContain("filename: archive.zip");
    expect(request?.payload.text).toContain("size_bytes: 36700160");
  });

  it("downloads rich Telegram media-only messages as attachments", async () => {
    const cases = [
      {
        name: "video",
        msg: {
          video: {
            file_id: "video-file",
            mime_type: "video/mp4",
            file_size: 5,
            file_name: "clip.mp4",
            duration: 8,
            width: 640,
            height: 360,
          },
        },
        expectedMimeType: "video/mp4",
        expectedMetadata: {
          telegramMediaKind: "video",
          duration: 8,
          width: 640,
          height: 360,
        },
      },
      {
        name: "audio",
        msg: {
          audio: {
            file_id: "audio-file",
            mime_type: "audio/mpeg",
            file_size: 5,
            file_name: "song.mp3",
            duration: 180,
            title: "Song",
            performer: "Band",
          },
        },
        expectedMimeType: "audio/mpeg",
        expectedMetadata: {
          telegramMediaKind: "audio",
          duration: 180,
          title: "Song",
          performer: "Band",
        },
      },
      {
        name: "animation",
        msg: {
          animation: {
            file_id: "animation-file",
            file_size: 5,
            file_name: "fun.gif",
            duration: 2,
            width: 320,
            height: 240,
          },
          document: {
            file_id: "legacy-document-file",
            file_size: 5,
            file_name: "fun.gif",
            mime_type: "image/gif",
          },
        },
        expectedMimeType: "image/gif",
        expectedMetadata: {
          telegramMediaKind: "animation",
          duration: 2,
          width: 320,
          height: 240,
        },
      },
      {
        name: "video note",
        msg: {
          video_note: {
            file_id: "video-note-file",
            file_size: 5,
            duration: 4,
            length: 240,
          },
        },
        expectedMimeType: "video/mp4",
        expectedMetadata: {
          telegramMediaKind: "video_note",
          duration: 4,
          length: 240,
        },
      },
    ];

    for (const testCase of cases) {
      const stores = createStores();
      const service = createInitializedService(stores);
      latestBot().api.getFile.mockResolvedValueOnce({
        file_path: `${testCase.name.replace(/\s+/g, "-")}/file`,
      });
      stubTelegramFileDownload();

      await (service as never).handleMessage({
        ...createTelegramContext(),
        msg: {
          message_id: 600,
          chat: {
            id: 777,
          },
          ...testCase.msg,
        },
      });

      expect(stores.mediaStore.writeMedia).toHaveBeenCalledTimes(1);
      expect(stores.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
        source: "telegram",
        connectorKey: "42",
        mimeType: testCase.expectedMimeType,
        sizeBytes: 5,
        metadata: expect.objectContaining({
          telegramFileId: expect.any(String),
          telegramFilePath: expect.any(String),
          ...testCase.expectedMetadata,
        }),
      }));
      expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
        kind: "telegram_message",
        payload: expect.objectContaining({
          text: "",
          media: [expect.objectContaining({
            mimeType: testCase.expectedMimeType,
          })],
        }),
      }));
    }
  });

  it("preserves WebP, video, and animated Telegram stickers", async () => {
    const cases = [
      {
        sticker: {
          file_id: "webp-sticker",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
          file_size: 5,
          emoji: "🙂",
          set_name: "panda",
        },
        expectedMimeType: "image/webp",
      },
      {
        sticker: {
          file_id: "video-sticker",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: false,
          is_video: true,
          file_size: 5,
        },
        expectedMimeType: "video/webm",
      },
      {
        sticker: {
          file_id: "animated-sticker",
          type: "regular",
          width: 512,
          height: 512,
          is_animated: true,
          is_video: false,
          file_size: 5,
        },
        expectedMimeType: "application/x-tgsticker",
      },
    ];

    for (const testCase of cases) {
      const stores = createStores();
      const service = createInitializedService(stores);
      stubTelegramFileDownload();

      await (service as never).handleMessage({
        ...createTelegramContext(),
        msg: {
          message_id: 601,
          chat: {
            id: 777,
          },
          sticker: testCase.sticker,
        },
      });

      expect(stores.mediaStore.writeMedia).toHaveBeenCalledWith(expect.objectContaining({
        mimeType: testCase.expectedMimeType,
        metadata: expect.objectContaining({
          telegramMediaKind: "sticker",
          stickerType: "regular",
          isAnimated: testCase.sticker.is_animated,
          isVideo: testCase.sticker.is_video,
          width: 512,
          height: 512,
        }),
      }));
      expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({
          text: "",
          media: [expect.objectContaining({
            mimeType: testCase.expectedMimeType,
          })],
        }),
      }));
    }
  });

  it("enqueues Telegram contact, location, and venue messages as structured text", async () => {
    const cases = [
      {
        msg: {
          contact: {
            first_name: "Alice",
            last_name: "Example",
            phone_number: "+421900000000",
            user_id: 987,
            vcard: "BEGIN:VCARD\nFN:Alice Example\nEND:VCARD",
          },
        },
        snippets: ["Telegram contact:", "Alice Example", "+421900000000", "telegram_user_id: 987", "BEGIN:VCARD"],
      },
      {
        msg: {
          location: {
            latitude: 48.1486,
            longitude: 17.1077,
            horizontal_accuracy: 12,
          },
        },
        snippets: ["Telegram location:", "latitude: 48.1486", "longitude: 17.1077", "https://maps.google.com/?q=48.1486,17.1077"],
      },
      {
        msg: {
          venue: {
            location: {
              latitude: 48.1486,
              longitude: 17.1077,
            },
            title: "Office",
            address: "Main Street 1",
            google_place_id: "place-1",
          },
        },
        snippets: ["Telegram venue:", "title: Office", "address: Main Street 1", "google_place_id: place-1"],
      },
    ];

    for (const testCase of cases) {
      const stores = createStores();
      const service = createInitializedService(stores);

      await (service as never).handleMessage({
        ...createTelegramContext(),
        msg: {
          message_id: 602,
          chat: {
            id: 777,
          },
          ...testCase.msg,
        },
      });

      expect(latestBot().api.getFile).not.toHaveBeenCalled();
      expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
        kind: "telegram_message",
        payload: expect.objectContaining({
          media: [],
          text: expect.any(String),
        }),
      }));
      const request = stores.requests.enqueueRequest.mock.calls[0]?.[0];
      for (const snippet of testCase.snippets) {
        expect(request?.payload.text).toContain(snippet);
      }
      if ("venue" in testCase.msg) {
        expect(request?.payload.text).not.toContain("Telegram location:");
      }
    }
  });

  it("aborts stalled Telegram file downloads", async () => {
    vi.useFakeTimers();
    const stores = createStores();
    const service = createInitializedService(stores);
    const abortError = Object.assign(new Error("aborted"), {name: "AbortError"});
    vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(abortError);
      }, {once: true});
    })));

    const handled = (service as never).handleMessage({
      ...createTelegramContext(),
      msg: {
        message_id: 606,
        chat: {
          id: 777,
        },
        video: {
          file_id: "slow-video",
          file_size: 5,
          duration: 2,
          width: 320,
          height: 240,
        },
      },
    });
    const expectation = expect(handled).rejects.toThrow("Telegram file slow-video download timed out after 30000ms.");

    await vi.advanceTimersByTimeAsync(30_000);
    await expectation;
    expect(stores.requests.enqueueRequest).not.toHaveBeenCalled();
  });

  it("keeps captions when downloading rich Telegram media", async () => {
    const stores = createStores();
    const service = createInitializedService(stores);
    stubTelegramFileDownload();

    await (service as never).handleMessage({
      ...createTelegramContext(),
      msg: {
        message_id: 603,
        caption: "watch this",
        chat: {
          id: 777,
        },
        video: {
          file_id: "video-file",
          file_size: 5,
          duration: 2,
          width: 320,
          height: 240,
        },
      },
    });

    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        text: "watch this",
        media: [expect.objectContaining({
          mimeType: "video/mp4",
        })],
      }),
    }));
  });

  it("turns oversized rich Telegram media into unavailable-attachment notices", async () => {
    const stores = createStores();
    const service = createInitializedService(stores);
    const bot = latestBot();

    await (service as never).handleMessage({
      ...createTelegramContext(),
      msg: {
        message_id: 604,
        chat: {
          id: 777,
        },
        video: {
          file_id: "big-video",
          file_size: 35 * 1024 * 1024,
          file_name: "clip.mp4",
          duration: 8,
          width: 640,
          height: 360,
        },
      },
    });

    expect(bot.api.getFile).not.toHaveBeenCalled();
    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: "telegram_message",
      payload: expect.objectContaining({
        externalMessageId: "604",
        media: [],
        text: expect.stringContaining("Telegram attachment unavailable:"),
      }),
    }));
    const request = stores.requests.enqueueRequest.mock.calls[0]?.[0];
    expect(request?.payload.text).toContain("- video");
    expect(request?.payload.text).toContain("filename: clip.mp4");
    expect(request?.payload.text).toContain("size_bytes: 36700160");
  });

  it("logs unsupported Telegram message shapes before dropping", async () => {
    const stores = createStores();
    const service = createInitializedService(stores);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await (service as never).handleMessage({
      ...createTelegramContext(),
      msg: {
        message_id: 605,
        chat: {
          id: 777,
        },
        poll: {
          id: "poll-1",
          question: "Which one?",
          options: [],
          total_voter_count: 0,
          is_closed: false,
          is_anonymous: true,
          type: "regular",
          allows_multiple_answers: false,
        },
      },
    });

    expect(stores.requests.enqueueRequest).not.toHaveBeenCalled();
    const logs = write.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    expect(logs).toContainEqual(expect.objectContaining({
      event: "message_dropped",
      reason: "unsupported_message_shape",
      messageShape: "poll",
    }));
  });

  it("drops unsupported non-private messages before enqueuing runtime work", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });

    const bot = latestBot();
    await (service as never).handleMessage({
      ...createTelegramContext(),
      chat: {
        id: -100123,
        type: "group",
      },
      msg: {
        message_id: 557,
        chat: {
          id: -100123,
        },
        video: {
          file_id: "group-video",
          file_size: 5,
        },
      },
    });

    expect(stores.requests.enqueueRequest).not.toHaveBeenCalled();
    expect(bot.api.getFile).not.toHaveBeenCalled();
  });

  it("enqueues reaction requests for added emoji", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });

    await (service as never).handleMessageReaction(createTelegramReactionContext());

    expect(stores.requests.enqueueRequest).toHaveBeenCalledWith({
      kind: "telegram_reaction",
      payload: {
        connectorKey: "42",
        externalConversationId: "777",
        chatId: "777",
        chatType: "private",
        externalActorId: "123",
        updateId: 777001,
        targetMessageId: "555",
        addedEmojis: ["🔥"],
        username: "alice",
        firstName: "Alice",
        lastName: "Liddell",
      },
    });
  });

  it("ignores reaction removals, bot actors, and non-private chats", async () => {
    const stores = createStores();
    const service = new TelegramService({
      token: "telegram-token",
      dataDir: "/tmp/panda",
    });

    vi.spyOn(service as never, "ensureInitialized").mockResolvedValue({
      stores,
      connectorKey: "42",
      botUsername: "panda_bot",
    });

    await (service as never).handleMessageReaction(createTelegramReactionContext({
      messageReaction: {
        chat: {
          id: 777,
          type: "private",
        },
        message_id: 555,
        user: {
          id: 123,
          username: "alice",
          is_bot: false,
        },
        old_reaction: [{type: "emoji", emoji: "🔥"}],
        new_reaction: [{type: "emoji", emoji: "🔥"}],
      },
    }));
    await (service as never).handleMessageReaction(createTelegramReactionContext({
      messageReaction: {
        chat: {
          id: 777,
          type: "private",
        },
        message_id: 555,
        user: {
          id: 123,
          username: "alice",
          is_bot: true,
        },
        old_reaction: [],
        new_reaction: [{type: "emoji", emoji: "🔥"}],
      },
    }));
    await (service as never).handleMessageReaction(createTelegramReactionContext({
      messageReaction: {
        chat: {
          id: -100123,
          type: "group",
        },
        message_id: 555,
        user: {
          id: 123,
          username: "alice",
          is_bot: false,
        },
        old_reaction: [],
        new_reaction: [{type: "emoji", emoji: "🔥"}],
      },
    }));

    expect(stores.requests.enqueueRequest).not.toHaveBeenCalled();
  });
});
