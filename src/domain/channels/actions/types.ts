import type {ChannelTypingRequest} from "../types.js";

export type ChannelActionKind = "typing" | "telegram_reaction";
export type ChannelActionStatus = "pending" | "sending" | "sent" | "failed";

export interface TelegramReactionActionPayload {
  conversationId: string;
  messageId: string;
  emoji?: string;
  remove?: boolean;
}

export type ChannelActionPayload =
  | ChannelTypingRequest
  | TelegramReactionActionPayload;

export interface CreateChannelActionInput {
  channel: string;
  connectorKey: string;
  kind: ChannelActionKind;
  payload: ChannelActionPayload;
}

export interface ChannelActionRecord extends CreateChannelActionInput {
  id: string;
  status: ChannelActionStatus;
  attemptCount: number;
  lastError?: string;
  claimedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ChannelActionWorkerLookup {
  channel: string;
  connectorKey: string;
}

export interface ChannelActionNotification {
  channel: string;
  connectorKey: string;
}
