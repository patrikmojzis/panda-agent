import type {ChannelTypingRequest} from "../types.js";

export type ChannelActionStatus = "pending" | "sending" | "sent" | "failed";

export interface TelegramReactionActionPayload {
  conversationId: string;
  messageId: string;
  emoji?: string;
  remove?: boolean;
}

export interface ChannelActionPayloadByKind {
  typing: ChannelTypingRequest;
  telegram_reaction: TelegramReactionActionPayload;
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
