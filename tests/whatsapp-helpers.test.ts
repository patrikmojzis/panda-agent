import {describe, expect, it} from "vitest";

import type {WAMessage} from "baileys";
import type {MediaDescriptor} from "../src/domain/channels/index.js";

import {
  buildWhatsAppInboundMetadata,
  buildWhatsAppInboundText,
  buildWhatsAppReactionMetadata,
  buildWhatsAppReactionText,
  describeWhatsAppMessageShape,
  extractWhatsAppMessageText,
  extractWhatsAppQuotedMessageId,
} from "../src/integrations/channels/whatsapp/helpers.js";

function mediaDescriptor(overrides: Partial<MediaDescriptor> = {}): MediaDescriptor {
  return {
    id: "media-1",
    source: "whatsapp",
    connectorKey: "main",
    mimeType: "image/jpeg",
    sizeBytes: 128,
    localPath: "/tmp/example.jpg",
    createdAt: 0,
    ...overrides,
  };
}

function waMessage(message: NonNullable<WAMessage["message"]>): WAMessage {
  return {
    key: {
      id: "wamid-1",
      remoteJid: "421900000000@s.whatsapp.net",
      fromMe: false,
    },
    message,
  } as WAMessage;
}

describe("whatsapp helpers", () => {
  it("extracts text from supported whatsapp message shapes", () => {
    expect(extractWhatsAppMessageText(waMessage({
      conversation: "  hello there  ",
    }))).toBe("hello there");

    expect(extractWhatsAppMessageText(waMessage({
      extendedTextMessage: {
        text: "reply text",
      },
    }))).toBe("reply text");

    expect(extractWhatsAppMessageText(waMessage({
      imageMessage: {
        caption: "photo caption",
      },
    }))).toBe("photo caption");

    expect(extractWhatsAppMessageText(waMessage({
      documentMessage: {
        caption: "doc caption",
      },
    }))).toBe("doc caption");

    expect(extractWhatsAppMessageText(waMessage({
      videoMessage: {
        caption: "video caption",
      },
    }))).toBe("video caption");

    expect(extractWhatsAppMessageText({
      key: {
        id: "wamid-2",
        remoteJid: "421900000000@s.whatsapp.net",
        fromMe: false,
      },
      message: {
        ephemeralMessage: {
          message: {
            conversation: "wrapped hello",
          },
        },
      },
    } as unknown as WAMessage)).toBe("wrapped hello");
  });

  it("extracts structured text from contacts and locations", () => {
    const contactText = extractWhatsAppMessageText(waMessage({
      contactMessage: {
        displayName: "Alice Example",
        vcard: "BEGIN:VCARD\nFN:Alice Example\nEND:VCARD",
      },
    }));
    expect(contactText).toContain("WhatsApp contact:");
    expect(contactText).toContain("Alice Example");
    expect(contactText).toContain("BEGIN:VCARD");

    const locationText = extractWhatsAppMessageText(waMessage({
      locationMessage: {
        name: "Office",
        address: "Main Street 1",
        degreesLatitude: 48.1486,
        degreesLongitude: 17.1077,
      },
    }));
    expect(locationText).toContain("WhatsApp location:");
    expect(locationText).toContain("Office");
    expect(locationText).toContain("https://maps.google.com/?q=48.1486,17.1077");
  });

  it("describes unsupported whatsapp message shapes", () => {
    expect(describeWhatsAppMessageShape(waMessage({
      pollCreationMessage: {
        name: "Which one?",
      },
    }))).toBe("pollCreationMessage");
  });

  it("extracts quoted message ids when present", () => {
    expect(extractWhatsAppQuotedMessageId(waMessage({
      extendedTextMessage: {
        text: "hello",
        contextInfo: {
          stanzaId: "quoted-123",
        },
      },
    }))).toBe("quoted-123");
  });

  it("builds whatsapp inbound text with a visible channel context block", () => {
    const text = buildWhatsAppInboundText({
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "wamid-1",
      identityHandle: "patrik",
      remoteJid: "421900000000@s.whatsapp.net",
      chatType: "private",
      pushName: "Patrik",
      quotedMessageId: "quoted-123",
      text: "hello from whatsapp",
      media: [
        mediaDescriptor({
          originalFilename: "photo.jpg",
        }),
      ],
    });

    expect(text).toContain("<runtime-channel-context>");
    expect(text).toContain("channel: whatsapp");
    expect(text).not.toContain("identity_id:");
    expect(text).toContain("identity_handle: patrik");
    expect(text).toContain("push_name: Patrik");
    expect(text).toContain("quoted_message_id: quoted-123");
    expect(text).toContain("photo.jpg");
    expect(text).toContain("hello from whatsapp");
  });

  it("builds panda metadata with route and whatsapp details", () => {
    const metadata = buildWhatsAppInboundMetadata({
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "wamid-1",
      remoteJid: "421900000000@s.whatsapp.net",
      chatType: "private",
      pushName: "Patrik",
      quotedMessageId: "quoted-123",
      media: [mediaDescriptor()],
    });

    expect(metadata).toMatchObject({
      route: {
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421900000000@s.whatsapp.net",
        externalActorId: "421900000000@s.whatsapp.net",
        externalMessageId: "wamid-1",
      },
      whatsapp: {
        remoteJid: "421900000000@s.whatsapp.net",
        chatType: "private",
        messageId: "wamid-1",
        pushName: "Patrik",
        quotedMessageId: "quoted-123",
      },
    });

    const whatsapp = metadata.whatsapp as { media: Array<{ localPath: string }> };
    expect(whatsapp.media[0]?.localPath).toBe("/tmp/example.jpg");
  });

  it("builds whatsapp reaction text and metadata", () => {
    const text = buildWhatsAppReactionText({
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "reaction-1",
      identityHandle: "patrik",
      remoteJid: "421900000000@s.whatsapp.net",
      chatType: "private",
      pushName: "Patrik",
      targetMessageId: "target-1",
      emoji: "👍",
    });

    expect(text).toContain("channel: whatsapp");
    expect(text).toContain("reaction_target_message_id: target-1");
    expect(text).toContain("Added reaction: 👍");

    expect(buildWhatsAppReactionMetadata({
      connectorKey: "main",
      externalConversationId: "421900000000@s.whatsapp.net",
      externalActorId: "421900000000@s.whatsapp.net",
      externalMessageId: "reaction-1",
      remoteJid: "421900000000@s.whatsapp.net",
      chatType: "private",
      pushName: "Patrik",
      targetMessageId: "target-1",
      emoji: "👍",
    })).toMatchObject({
      whatsapp: {
        reaction: {
          targetMessageId: "target-1",
          emoji: "👍",
          actorId: "421900000000@s.whatsapp.net",
        },
      },
    });
  });
});
