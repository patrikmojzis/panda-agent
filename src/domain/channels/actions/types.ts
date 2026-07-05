import type {ChannelTypingRequest} from "../types.js";

export type ChannelActionStatus = "pending" | "sending" | "sent" | "failed";

export interface TelegramReactionActionPayload {
  conversationId: string;
  messageId: string;
  emoji?: string;
  remove?: boolean;
}

export interface TelegramEditActionPayload {
  conversationId: string;
  messageId: string;
  text: string;
}

export interface TelegramDeleteActionPayload {
  conversationId: string;
  messageId: string;
}

export interface TelegramPinActionPayload {
  conversationId: string;
  messageId: string;
  silent?: boolean;
}

export interface TelegramUnpinActionPayload {
  conversationId: string;
  messageId: string;
}

export type TelegramStickerSendActionPayload = {
  conversationId: string;
  sticker:
    | {
        type: "file";
        path: string;
      }
    | {
        type: "file_id";
        fileId: string;
      };
};

export interface ChannelActionPayloadByKind {
  typing: ChannelTypingRequest;
  telegram_reaction: TelegramReactionActionPayload;
  telegram_edit: TelegramEditActionPayload;
  telegram_delete: TelegramDeleteActionPayload;
  telegram_pin: TelegramPinActionPayload;
  telegram_unpin: TelegramUnpinActionPayload;
  telegram_sticker_send: TelegramStickerSendActionPayload;
}

export type ChannelActionKind = keyof ChannelActionPayloadByKind;
export type ChannelActionPayload = ChannelActionPayloadByKind[ChannelActionKind];

export type ChannelActionInput<K extends ChannelActionKind = ChannelActionKind> = {
  [Kind in K]: {
    channel: string;
    connectorKey: string;
    kind: Kind;
    payload: ChannelActionPayloadByKind[Kind];
  };
}[K];

type ChannelActionRecordForKind<K extends ChannelActionKind> = {
  channel: string;
  connectorKey: string;
  kind: K;
  payload: ChannelActionPayloadByKind[K];
  id: string;
  status: ChannelActionStatus;
  attemptCount: number;
  lastError?: string;
  claimedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type ChannelActionRecord<K extends ChannelActionKind = ChannelActionKind> = {
  [Kind in K]: ChannelActionRecordForKind<Kind>;
}[K];

export interface ActionWorkerLookup {
  channel: string;
  connectorKey: string;
}

export interface ActionNotification {
  channel: string;
  connectorKey: string;
}
