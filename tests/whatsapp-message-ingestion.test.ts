import type {WAMessage} from "baileys";
import {describe, expect, it, vi} from "vitest";

import {ingestWhatsAppMessagesUpsert} from "../src/integrations/channels/whatsapp/message-ingestion.js";

vi.mock("baileys", () => ({
  isJidBroadcast: (jid?: string) => Boolean(jid?.endsWith("@broadcast")),
  isJidGroup: (jid?: string) => Boolean(jid?.endsWith("@g.us")),
  isJidNewsletter: (jid?: string) => Boolean(jid?.endsWith("@newsletter")),
  isJidStatusBroadcast: (jid?: string) => jid === "status@broadcast",
  jidNormalizedUser: (jid: string) => jid,
}));

vi.mock("baileys/lib/Utils/messages.js", () => ({
  normalizeMessageContent: vi.fn((message) => message ?? undefined),
}));

function createIngestionOptions(media = []) {
  return {
    connectorKey: "main",
    requests: {
      enqueueRequest: vi.fn(async () => ({
        id: "request-1",
      })),
    },
    downloadMedia: vi.fn(async () => media),
    logs: [] as Array<{event: string; payload: Record<string, unknown>}>,
  };
}

function createPrivateMessage(overrides: Partial<WAMessage> = {}): WAMessage {
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
  } as WAMessage;
}

async function ingest(
  options: ReturnType<typeof createIngestionOptions>,
  messages: readonly WAMessage[],
  type: "notify" | "append" = "notify",
) {
  await ingestWhatsAppMessagesUpsert({
    type,
    messages,
  }, {
    connectorKey: options.connectorKey,
    requests: options.requests,
    downloadMedia: options.downloadMedia,
    log: (event, payload) => {
      options.logs.push({event, payload});
    },
  });
}

describe("WhatsApp message ingestion", () => {
  it("enqueues private notify messages for Panda", async () => {
    const options = createIngestionOptions();

    await ingest(options, [createPrivateMessage()]);

    expect(options.requests.enqueueRequest).toHaveBeenCalledWith({
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
    const options = createIngestionOptions();

    await ingest(options, [createPrivateMessage()], "append");
    await ingest(options, [
      createPrivateMessage({
        key: {
          remoteJid: "group@g.us",
          participant: "123@s.whatsapp.net",
          id: "msg-2",
          fromMe: false,
        },
      }),
    ]);

    expect(options.requests.enqueueRequest).not.toHaveBeenCalled();
  });

  it("includes downloaded media in message requests", async () => {
    const media = [{
      id: "media-1",
      source: "whatsapp",
      connectorKey: "main",
      mimeType: "image/jpeg",
      sizeBytes: 128,
      localPath: "/tmp/media.bin",
      originalFilename: null,
      metadata: {},
      createdAt: 1,
    }];
    const options = createIngestionOptions(media);

    await ingest(options, [
      createPrivateMessage({
        message: {
          imageMessage: {
            caption: "see screenshot",
            mimetype: "image/jpeg",
            fileLength: 128,
          },
        },
      }),
    ]);

    expect(options.downloadMedia).toHaveBeenCalledTimes(1);
    expect(options.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: "whatsapp_message",
      payload: expect.objectContaining({
        text: "see screenshot",
        media,
      }),
    }));
  });

  it("enqueues voice-only audio messages as media", async () => {
    const media = [{
      id: "media-1",
      source: "whatsapp",
      connectorKey: "main",
      mimeType: "audio/ogg",
      sizeBytes: 321,
      localPath: "/tmp/media.bin",
      originalFilename: null,
      metadata: {
        whatsappMessageId: "msg-voice",
        whatsappRemoteJid: "123@s.whatsapp.net",
        whatsappMediaKind: "audio",
        ptt: true,
      },
      createdAt: 1,
    }];
    const options = createIngestionOptions(media);

    await ingest(options, [
      createPrivateMessage({
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
      }),
    ]);

    expect(options.requests.enqueueRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: "whatsapp_message",
      payload: expect.objectContaining({
        text: "",
        media,
      }),
    }));
    expect(options.logs).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({reason: "unsupported_message_shape"}),
    }));
  });

  it("enqueues contact-only messages as structured text", async () => {
    const options = createIngestionOptions();

    await ingest(options, [
      createPrivateMessage({
        message: {
          contactMessage: {
            displayName: "Alice Example",
            vcard: "BEGIN:VCARD\nFN:Alice Example\nTEL:+421900000000\nEND:VCARD",
          },
        },
      }),
    ]);

    const request = options.requests.enqueueRequest.mock.calls[0]?.[0];
    expect(request?.payload.text).toContain("WhatsApp contact:");
    expect(request?.payload.text).toContain("Alice Example");
    expect(request?.payload.text).toContain("BEGIN:VCARD");
  });

  it("enqueues contacts array messages as structured text", async () => {
    const options = createIngestionOptions();

    await ingest(options, [
      createPrivateMessage({
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
      }),
    ]);

    const request = options.requests.enqueueRequest.mock.calls[0]?.[0];
    expect(request?.payload.text).toContain("WhatsApp contact 1:");
    expect(request?.payload.text).toContain("Alice");
    expect(request?.payload.text).toContain("WhatsApp contact 2:");
    expect(request?.payload.text).toContain("Bob");
  });

  it("enqueues location-only messages as structured text with a map link", async () => {
    const options = createIngestionOptions();

    await ingest(options, [
      createPrivateMessage({
        message: {
          locationMessage: {
            name: "Office",
            address: "Main Street 1",
            degreesLatitude: 48.1486,
            degreesLongitude: 17.1077,
          },
        },
      }),
    ]);

    const request = options.requests.enqueueRequest.mock.calls[0]?.[0];
    expect(request?.payload.text).toContain("WhatsApp location:");
    expect(request?.payload.text).toContain("Office");
    expect(request?.payload.text).toContain("https://maps.google.com/?q=48.1486,17.1077");
  });

  it("enqueues WhatsApp reactions separately from messages", async () => {
    const options = createIngestionOptions();

    await ingest(options, [
      createPrivateMessage({
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
      }),
    ]);

    expect(options.requests.enqueueRequest).toHaveBeenCalledWith({
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
    const options = createIngestionOptions();

    await ingest(options, [
      createPrivateMessage({
        message: {
          reactionMessage: {
            text: "",
            key: {
              id: "target-1",
            },
          },
        },
      }),
    ]);

    expect(options.requests.enqueueRequest).not.toHaveBeenCalled();
  });

  it("logs unsupported WhatsApp message shapes before dropping", async () => {
    const options = createIngestionOptions();

    await ingest(options, [
      createPrivateMessage({
        message: {
          pollCreationMessage: {
            name: "Which one?",
          },
        },
      }),
    ]);

    expect(options.requests.enqueueRequest).not.toHaveBeenCalled();
    expect(options.logs).toContainEqual({
      event: "message_dropped",
      payload: expect.objectContaining({
        reason: "unsupported_message_shape",
        messageShape: "pollCreationMessage",
      }),
    });
  });
});
