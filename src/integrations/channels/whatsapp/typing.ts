import type {WASocket} from "baileys";

import type {ChannelTypingAdapter, ChannelTypingRequest} from "../../../domain/channels/index.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {assertWhatsAppConnectorKey, requireWhatsAppSocket} from "./transport.js";

export interface CreateWhatsAppTypingAdapterOptions {
  connectorKey: string;
  getSocket(): WASocket | null;
}

export function createWhatsAppTypingAdapter(
  options: CreateWhatsAppTypingAdapterOptions,
): ChannelTypingAdapter {
  return {
    channel: WHATSAPP_SOURCE,
    async send(request: ChannelTypingRequest): Promise<void> {
      assertWhatsAppConnectorKey(options.connectorKey, request.target.connectorKey, "typing");
      const socket = requireWhatsAppSocket(options.getSocket, "typing");
      const jid = request.target.externalConversationId;
      await socket.sendPresenceUpdate(request.phase === "stop" ? "paused" : "composing", jid);
    },
  };
}
