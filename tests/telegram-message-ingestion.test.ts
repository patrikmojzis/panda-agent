import {describe, expect, it, vi} from "vitest";

import {
  ingestTelegramMessage,
  ingestTelegramMessageReaction,
} from "../src/integrations/channels/telegram/message-ingestion.js";

function createRequests() {
  return {
    enqueueRequest: vi.fn(async () => ({
      id: "request-1",
    })),
  };
}

function createMessageOptions(overrides: Record<string, unknown> = {}) {
  return {
    connectorKey: "42",
    botUsername: "panda_bot",
    requests: createRequests(),
    downloadMedia: vi.fn(async () => ({
      media: [],
      unavailable: [],
    })),
    logs: [] as Array<{event: string; payload: Record<string, unknown>}>,
    log(event: string, payload: Record<string, unknown>) {
      this.logs.push({event, payload});
    },
    ...overrides,
  };
}

function createReactionOptions(overrides: Record<string, unknown> = {}) {
  return {
    connectorKey: "42",
    requests: createRequests(),
    logs: [] as Array<{event: string; payload: Record<string, unknown>}>,
    log(event: string, payload: Record<string, unknown>) {
      this.logs.push({event, payload});
    },
    ...overrides,
  };
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

describe("Telegram message ingestion", () => {
  it("enqueues Telegram message requests with the normalized payload", async () => {
    const options = createMessageOptions();

    await ingestTelegramMessage(createTelegramContext(), options);

    expect(options.requests.enqueueRequest).toHaveBeenCalledWith({
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

  it("merges unavailable Telegram media notices into inbound text", async () => {
    const options = createMessageOptions({
      downloadMedia: vi.fn(async () => ({
        media: [],
        unavailable: [{
          kind: "document",
          mimeType: "application/zip",
          sizeBytes: 35 * 1024 * 1024,
          filename: "archive.zip",
          reason: "Telegram Bot API only exposes bot-downloadable files up to 20 MB.",
        }],
      })),
    });

    await ingestTelegramMessage({
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
    }, options);

    expect(options.requests.enqueueRequest).toHaveBeenCalledWith({
      kind: "telegram_message",
      payload: expect.objectContaining({
        externalMessageId: "556",
        media: [],
        text: expect.stringContaining("Telegram attachment unavailable:"),
      }),
    });
    const request = options.requests.enqueueRequest.mock.calls[0]?.[0];
    expect(request?.payload.text).toContain("filename: archive.zip");
    expect(request?.payload.text).toContain("size_bytes: 36700160");
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
      const options = createMessageOptions();

      await ingestTelegramMessage({
        ...createTelegramContext(),
        msg: {
          message_id: 602,
          chat: {
            id: 777,
          },
          ...testCase.msg,
        },
      }, options);

      expect(options.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
        kind: "telegram_message",
        payload: expect.objectContaining({
          media: [],
          text: expect.any(String),
        }),
      }));
      const request = options.requests.enqueueRequest.mock.calls[0]?.[0];
      for (const snippet of testCase.snippets) {
        expect(request?.payload.text).toContain(snippet);
      }
      if ("venue" in testCase.msg) {
        expect(request?.payload.text).not.toContain("Telegram location:");
      }
    }
  });

  it("keeps captions when downloading rich Telegram media", async () => {
    const media = [{
      id: "media-1",
      source: "telegram",
      connectorKey: "42",
      mimeType: "video/mp4",
      sizeBytes: 5,
      localPath: "/tmp/media.bin",
      originalFilename: undefined,
      metadata: {},
      createdAt: 1,
    }];
    const options = createMessageOptions({
      downloadMedia: vi.fn(async () => ({
        media,
        unavailable: [],
      })),
    });

    await ingestTelegramMessage({
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
    }, options);

    expect(options.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({
        text: "watch this",
        media,
      }),
    }));
  });

  it("logs unsupported Telegram message shapes before dropping", async () => {
    const options = createMessageOptions();

    await ingestTelegramMessage({
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
    }, options);

    expect(options.requests.enqueueRequest).not.toHaveBeenCalled();
    expect(options.logs).toContainEqual({
      event: "message_dropped",
      payload: expect.objectContaining({
        reason: "unsupported_message_shape",
        messageShape: "poll",
      }),
    });
  });

  it("drops unsupported non-private messages before downloading media", async () => {
    const options = createMessageOptions();

    await ingestTelegramMessage({
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
    }, options);

    expect(options.requests.enqueueRequest).not.toHaveBeenCalled();
    expect(options.downloadMedia).not.toHaveBeenCalled();
  });

  it("enqueues Telegram reaction requests for added emoji", async () => {
    const options = createReactionOptions();

    await ingestTelegramMessageReaction(createTelegramReactionContext(), options);

    expect(options.requests.enqueueRequest).toHaveBeenCalledWith({
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
    const options = createReactionOptions();

    await ingestTelegramMessageReaction(createTelegramReactionContext({
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
    }), options);
    await ingestTelegramMessageReaction(createTelegramReactionContext({
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
    }), options);
    await ingestTelegramMessageReaction(createTelegramReactionContext({
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
    }), options);

    expect(options.requests.enqueueRequest).not.toHaveBeenCalled();
  });
});
