import {describe, expect, it, vi} from "vitest";

import {createWhatsAppTypingAdapter, type WhatsAppTypingSocket} from "../src/integrations/channels/whatsapp/typing.js";

function mockSocket(sendPresenceUpdate: ReturnType<typeof vi.fn>): WhatsAppTypingSocket {
  return {sendPresenceUpdate};
}

describe("createWhatsAppTypingAdapter", () => {
  it("maps start and keepalive to composing and stop to paused", async () => {
    const sendPresenceUpdate = vi.fn(async () => {});
    const adapter = createWhatsAppTypingAdapter({
      connectorKey: "main",
      getSocket: () => mockSocket(sendPresenceUpdate),
    });

    await adapter.send({
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421911111111@s.whatsapp.net",
      },
      phase: "start",
    });
    await adapter.send({
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421911111111@s.whatsapp.net",
      },
      phase: "keepalive",
    });
    await adapter.send({
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421911111111@s.whatsapp.net",
      },
      phase: "stop",
    });

    expect(sendPresenceUpdate).toHaveBeenNthCalledWith(1, "composing", "421911111111@s.whatsapp.net");
    expect(sendPresenceUpdate).toHaveBeenNthCalledWith(2, "composing", "421911111111@s.whatsapp.net");
    expect(sendPresenceUpdate).toHaveBeenNthCalledWith(3, "paused", "421911111111@s.whatsapp.net");
  });

  it("fails when the live socket is unavailable", async () => {
    const adapter = createWhatsAppTypingAdapter({
      connectorKey: "main",
      getSocket: () => null,
    });

    await expect(adapter.send({
      channel: "whatsapp",
      target: {
        source: "whatsapp",
        connectorKey: "main",
        externalConversationId: "421911111111@s.whatsapp.net",
      },
      phase: "start",
    })).rejects.toThrow("WhatsApp typing is unavailable because the connector socket is not connected.");
  });
});
