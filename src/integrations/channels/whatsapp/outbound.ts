import {readFile} from "node:fs/promises";
import path from "node:path";

import type {WASocket} from "baileys";

import type {
  ChannelOutboundAdapter,
  OutboundRequest,
  OutboundResult,
  OutboundSentItem
} from "../../../domain/channels/index.js";
import {WHATSAPP_SOURCE} from "./config.js";
import {assertWhatsAppConnectorKey, requireWhatsAppSocket} from "./transport.js";

export interface CreateWhatsAppOutboundAdapterOptions {
  connectorKey: string;
  getSocket(): WASocket | null;
}

function requireSentItemId(itemType: OutboundSentItem["type"], sent: Awaited<ReturnType<WASocket["sendMessage"]>>): OutboundSentItem {
  const externalMessageId = sent?.key.id?.trim();
  if (!externalMessageId) {
    throw new Error(`WhatsApp ${itemType} send did not return a message id.`);
  }

  return {
    type: itemType,
    externalMessageId,
  };
}

export function createWhatsAppOutboundAdapter(
  options: CreateWhatsAppOutboundAdapterOptions,
): ChannelOutboundAdapter {
  return {
    channel: WHATSAPP_SOURCE,
    async send(request: OutboundRequest): Promise<OutboundResult> {
      assertWhatsAppConnectorKey(options.connectorKey, request.target.connectorKey, "outbound");
      const socket = requireWhatsAppSocket(options.getSocket, "outbound");
      const jid = request.target.externalConversationId;
      const sent: OutboundSentItem[] = [];

      for (const item of request.items) {
        switch (item.type) {
          case "text": {
            const message = await socket.sendMessage(jid, {
              text: item.text,
            });
            sent.push(requireSentItemId("text", message));
            break;
          }
          case "image": {
            const image = await readFile(item.path);
            const message = await socket.sendMessage(jid, {
              image,
              ...(item.caption ? { caption: item.caption } : {}),
            });
            sent.push(requireSentItemId("image", message));
            break;
          }
          case "file": {
            const document = await readFile(item.path);
            const message = await socket.sendMessage(jid, {
              document,
              fileName: item.filename?.trim() || path.basename(item.path),
              mimetype: item.mimeType?.trim() || "application/octet-stream",
              ...(item.caption ? { caption: item.caption } : {}),
            });
            sent.push(requireSentItemId("file", message));
            break;
          }
        }
      }

      return {
        ok: true,
        channel: request.channel,
        target: request.target,
        sent,
      };
    },
  };
}
