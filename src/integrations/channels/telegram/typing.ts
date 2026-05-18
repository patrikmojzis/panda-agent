import type {Api} from "grammy";

import type {ChannelTypingRequest} from "../../../domain/channels/types.js";
import type {ChannelTypingAdapter} from "../../../domain/channels/typing.js";
import {TELEGRAM_SOURCE} from "./config.js";
import {parseTelegramConversationId} from "./conversation-id.js";
import {assertTelegramConnectorKey} from "./transport.js";

export type TelegramTypingApi = Pick<Api, "sendChatAction">;

export interface TelegramTypingAdapterOptions {
  api: TelegramTypingApi;
  connectorKey: string;
}

export function createTelegramTypingAdapter(
  options: TelegramTypingAdapterOptions,
): ChannelTypingAdapter {
  return {
    channel: TELEGRAM_SOURCE,
    async send(request: ChannelTypingRequest): Promise<void> {
      assertTelegramConnectorKey(options.connectorKey, request.target.connectorKey, "typing");
      if (request.phase === "stop") {
        return;
      }

      const route = parseTelegramConversationId(request.target.externalConversationId);
      await options.api.sendChatAction(route.chatId, "typing", {
        ...(route.messageThreadId !== undefined ? { message_thread_id: route.messageThreadId } : {}),
      });
    },
  };
}
