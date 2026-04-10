import type {JsonValue, ProviderName} from "../agent-core/types.js";
import type {MediaDescriptor} from "../channels/core/types.js";
import type {ThinkingLevel} from "@mariozechner/pi-ai";
import type {ThreadUpdate} from "../thread-runtime/types.js";

export type PandaRuntimeRequestKind =
  | "telegram_message"
  | "telegram_reaction"
  | "whatsapp_message"
  | "tui_input"
  | "create_thread"
  | "resolve_home_thread"
  | "reset_home_thread"
  | "abort_thread"
  | "compact_thread"
  | "update_thread";

export type PandaRuntimeRequestStatus = "pending" | "running" | "completed" | "failed";

export interface BaseRuntimeRequestPayload {
  identityId?: string;
}

export interface TelegramMessageRequestPayload extends BaseRuntimeRequestPayload {
  connectorKey: string;
  botUsername?: string | null;
  externalConversationId: string;
  chatId: string;
  chatType: string;
  externalActorId: string;
  externalMessageId: string;
  text?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  replyToMessageId?: string;
  media: readonly MediaDescriptor[];
  provider?: ProviderName;
  model?: string;
}

export interface TelegramReactionRequestPayload extends BaseRuntimeRequestPayload {
  connectorKey: string;
  externalConversationId: string;
  chatId: string;
  chatType: string;
  externalActorId: string;
  updateId: number;
  targetMessageId: string;
  addedEmojis: readonly string[];
  username?: string;
  firstName?: string;
  lastName?: string;
  provider?: ProviderName;
  model?: string;
}

export interface WhatsAppMessageRequestPayload extends BaseRuntimeRequestPayload {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  remoteJid: string;
  chatType: string;
  text?: string;
  pushName?: string;
  quotedMessageId?: string;
  media: readonly MediaDescriptor[];
  provider?: ProviderName;
  model?: string;
}

export interface TuiInputRequestPayload extends BaseRuntimeRequestPayload {
  threadId?: string;
  actorId: string;
  externalMessageId: string;
  text: string;
}

export interface CreateThreadRequestPayload extends BaseRuntimeRequestPayload {
  id?: string;
  agentKey?: string;
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface ResolveHomeThreadRequestPayload extends BaseRuntimeRequestPayload {
  agentKey?: string;
  provider?: ProviderName;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface ResetHomeThreadRequestPayload extends BaseRuntimeRequestPayload {
  source: "telegram" | "tui";
  connectorKey?: string;
  externalConversationId?: string;
  externalActorId?: string;
  commandExternalMessageId?: string;
  provider?: ProviderName;
  model?: string;
}

export interface AbortThreadRequestPayload extends BaseRuntimeRequestPayload {
  threadId: string;
  reason?: string;
}

export interface CompactThreadRequestPayload extends BaseRuntimeRequestPayload {
  threadId: string;
  customInstructions: string;
}

export interface UpdateThreadRequestPayload extends BaseRuntimeRequestPayload {
  threadId: string;
  update: ThreadUpdate;
}

export type PandaRuntimeRequestPayload =
  | TelegramMessageRequestPayload
  | TelegramReactionRequestPayload
  | WhatsAppMessageRequestPayload
  | TuiInputRequestPayload
  | CreateThreadRequestPayload
  | ResolveHomeThreadRequestPayload
  | ResetHomeThreadRequestPayload
  | AbortThreadRequestPayload
  | CompactThreadRequestPayload
  | UpdateThreadRequestPayload;

export interface CreateRuntimeRequestInput<TPayload extends PandaRuntimeRequestPayload = PandaRuntimeRequestPayload> {
  kind: PandaRuntimeRequestKind;
  payload: TPayload;
}

export interface PandaRuntimeRequestRecord<TPayload extends PandaRuntimeRequestPayload = PandaRuntimeRequestPayload> {
  id: string;
  kind: PandaRuntimeRequestKind;
  status: PandaRuntimeRequestStatus;
  payload: TPayload;
  result?: JsonValue;
  error?: string;
  claimedAt?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}
