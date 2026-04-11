import path from "node:path";

import {type Api, InputFile} from "grammy";

import type {
    ChannelOutboundAdapter,
    OutboundRequest,
    OutboundResult,
    OutboundSentItem
} from "../../../domain/channels/index.js";
import {TELEGRAM_SOURCE} from "./config.js";
import {type ParsedTelegramConversationId, parseTelegramConversationId} from "./conversation-id.js";
import {markdownToTelegramHtml} from "./format.js";
import {assertTelegramConnectorKey} from "./transport.js";

export interface TelegramOutboundAdapterOptions {
  api: Api;
  connectorKey: string;
}

const TELEGRAM_PARSE_ERROR_RE =
  /can't parse entities|parse entities|find end of the entity|find end tag|unsupported start tag|unclosed start tag/i;

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

function sentItem(type: OutboundSentItem["type"], externalMessageId: number): OutboundSentItem {
  return {
    type,
    externalMessageId: String(externalMessageId),
  };
}

function isTelegramParseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TELEGRAM_PARSE_ERROR_RE.test(message);
}

// Telegram HTML is much less brittle than MarkdownV2, so we render once here
// and only fall back to plain text when Telegram rejects the formatted payload.
async function sendWithTelegramHtmlFallback<T>(params: {
  rawText: string;
  sendFormatted(htmlText: string): Promise<T>;
  sendPlain(plainText: string): Promise<T>;
}): Promise<T> {
  const htmlText = markdownToTelegramHtml(params.rawText);
  if (!htmlText.trim()) {
    return await params.sendPlain(params.rawText);
  }

  try {
    return await params.sendFormatted(htmlText);
  } catch (error) {
    if (!isTelegramParseError(error)) {
      throw error;
    }

    return await params.sendPlain(params.rawText);
  }
}

export function createTelegramOutboundAdapter(
  options: TelegramOutboundAdapterOptions,
): ChannelOutboundAdapter {
  return {
    channel: TELEGRAM_SOURCE,
    async send(request: OutboundRequest): Promise<OutboundResult> {
      assertTelegramConnectorKey(options.connectorKey, request.target.connectorKey, "outbound");
      const route = parseTelegramConversationId(request.target.externalConversationId);
      const telegramOptions = buildTelegramSendOptions(route, request.target.replyToMessageId);
      const sent: OutboundSentItem[] = [];

      for (const item of request.items) {
        switch (item.type) {
          case "text": {
            const message = await sendWithTelegramHtmlFallback({
              rawText: item.text,
              sendFormatted: async (htmlText) => await options.api.sendMessage(route.chatId, htmlText, {
                ...telegramOptions,
                parse_mode: "HTML",
              }),
              sendPlain: async (plainText) => await options.api.sendMessage(route.chatId, plainText, telegramOptions),
            });
            sent.push(sentItem("text", message.message_id));
            break;
          }
          case "image": {
            const createImage = () => new InputFile(item.path, path.basename(item.path));
            const message = item.caption
              ? await sendWithTelegramHtmlFallback({
                rawText: item.caption,
                sendFormatted: async (htmlText) => await options.api.sendPhoto(route.chatId, createImage(), {
                  ...telegramOptions,
                  caption: htmlText,
                  parse_mode: "HTML",
                }),
                sendPlain: async (plainText) => await options.api.sendPhoto(route.chatId, createImage(), {
                  ...telegramOptions,
                  caption: plainText,
                }),
              })
              : await options.api.sendPhoto(route.chatId, createImage(), telegramOptions);
            sent.push(sentItem("image", message.message_id));
            break;
          }
          case "file": {
            const filename = item.filename?.trim() || path.basename(item.path);
            const createDocument = () => new InputFile(item.path, filename);
            const message = item.caption
              ? await sendWithTelegramHtmlFallback({
                rawText: item.caption,
                sendFormatted: async (htmlText) => await options.api.sendDocument(route.chatId, createDocument(), {
                  ...telegramOptions,
                  caption: htmlText,
                  parse_mode: "HTML",
                }),
                sendPlain: async (plainText) => await options.api.sendDocument(route.chatId, createDocument(), {
                  ...telegramOptions,
                  caption: plainText,
                }),
              })
              : await options.api.sendDocument(route.chatId, createDocument(), telegramOptions);
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
