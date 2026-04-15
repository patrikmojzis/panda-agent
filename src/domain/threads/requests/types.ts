import type {JsonValue} from "../../../kernel/agent/types.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {ThinkingLevel} from "@mariozechner/pi-ai";
import type {InferenceProjection, ThreadUpdate} from "../runtime/types.js";

export type PandaRuntimeRequestKind =
  | "telegram_message"
  | "telegram_reaction"
  | "whatsapp_message"
  | "tui_input"
  | "create_branch_session"
  | "resolve_main_session_thread"
  | "reset_session"
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
}

export interface TuiInputRequestPayload extends BaseRuntimeRequestPayload {
  threadId?: string;
  actorId: string;
  externalMessageId: string;
  identityHandle?: string;
  text: string;
}

export interface CreateBranchSessionRequestPayload extends BaseRuntimeRequestPayload {
  sessionId?: string;
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

export interface ResolveMainSessionThreadRequestPayload extends BaseRuntimeRequestPayload {
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

export interface ResetSessionRequestPayload extends BaseRuntimeRequestPayload {
  source: "telegram" | "tui" | "operator";
  sessionId?: string;
  threadId?: string;
  connectorKey?: string;
  externalConversationId?: string;
  externalActorId?: string;
  commandExternalMessageId?: string;
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
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
  | CreateBranchSessionRequestPayload
  | ResolveMainSessionThreadRequestPayload
  | ResetSessionRequestPayload
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
