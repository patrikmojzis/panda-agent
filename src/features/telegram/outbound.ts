import path from "node:path";

import { InputFile, type Api } from "grammy";

import type { ChannelOutboundAdapter, OutboundRequest, OutboundResult, OutboundSentItem } from "../channels/core/index.js";
import { TELEGRAM_SOURCE } from "./config.js";

export interface TelegramOutboundAdapterOptions {
  api: Api;
  connectorKey: string;
}

interface ParsedTelegramConversationId {
  chatId: string;
  messageThreadId?: number;
}

function parseTelegramConversationId(value: string): ParsedTelegramConversationId {
  const trimmed = value.trim();
  const match = /^(-?\d+)(?::(\d+))?$/.exec(trimmed);
  if (!match?.[1]) {
    throw new Error(`Invalid Telegram conversation id ${value}.`);
  }

  return {
    chatId: match[1],
    messageThreadId: match[2] ? Number.parseInt(match[2], 10) : undefined,
  };
}

function buildTelegramSendOptions(route: ParsedTelegramConversationId, replyToMessageId?: string): Record<string, unknown> {
  const options: Record<string, unknown> = {};

  if (route.messageThreadId !== undefined) {
    options.message_thread_id = route.messageThreadId;
  }

  if (replyToMessageId) {
    options.reply_parameters = {
      message_id: Number.parseInt(replyToMessageId, 10),
      allow_sending_without_reply: true,
    };
  }

  return options;
}

function assertMatchingConnectorKey(expected: string, actual: string): void {
  if (expected === actual) {
    return;
  }

  throw new Error(`Telegram outbound connector mismatch. Expected ${expected}, got ${actual}.`);
}

function sentItem(type: OutboundSentItem["type"], externalMessageId: number): OutboundSentItem {
  return {
    type,
    externalMessageId: String(externalMessageId),
  };
}

export function createTelegramOutboundAdapter(
  options: TelegramOutboundAdapterOptions,
): ChannelOutboundAdapter {
  return {
    channel: TELEGRAM_SOURCE,
    async send(request: OutboundRequest): Promise<OutboundResult> {
      assertMatchingConnectorKey(options.connectorKey, request.target.connectorKey);
      const route = parseTelegramConversationId(request.target.externalConversationId);
      const telegramOptions = buildTelegramSendOptions(route, request.target.replyToMessageId);
      const sent: OutboundSentItem[] = [];

      for (const item of request.items) {
        switch (item.type) {
          case "text": {
            const message = await options.api.sendMessage(route.chatId, item.text, telegramOptions);
            sent.push(sentItem("text", message.message_id));
            break;
          }
          case "image": {
            const image = new InputFile(item.path, path.basename(item.path));
            const message = await options.api.sendPhoto(route.chatId, image, {
              ...telegramOptions,
              ...(item.caption ? { caption: item.caption } : {}),
            });
            sent.push(sentItem("image", message.message_id));
            break;
          }
          case "file": {
            const filename = item.filename?.trim() || path.basename(item.path);
            const document = new InputFile(item.path, filename);
            const message = await options.api.sendDocument(route.chatId, document, {
              ...telegramOptions,
              ...(item.caption ? { caption: item.caption } : {}),
            });
            sent.push(sentItem("file", message.message_id));
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
