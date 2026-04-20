import type {JsonValue} from "../../../kernel/agent/types.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {ThinkingLevel} from "@mariozechner/pi-ai";
import type {InferenceProjection, ThreadUpdate} from "../runtime/types.js";

export type RuntimeRequestKind =
  | "a2a_message"
  | "telegram_message"
  | "telegram_reaction"
  | "whatsapp_message"
  | "tui_input"
  | "create_branch_session"
  | "resolve_main_session_thread"
  | "resolve_thread_run_config"
  | "reset_session"
  | "abort_thread"
  | "compact_thread"
  | "update_thread";

export type RuntimeRequestStatus = "pending" | "running" | "completed" | "failed";

export interface BaseRuntimeRequestPayload {
  identityId?: string;
}

export interface A2AMessageTextItem {
  type: "text";
  text: string;
}

export interface A2AMessageImageItem {
  type: "image";
  media: MediaDescriptor;
  caption?: string;
}

export interface A2AMessageFileItem {
  type: "file";
  media: MediaDescriptor;
  filename?: string;
  caption?: string;
  mimeType?: string;
}

export type A2AMessageItem =
  | A2AMessageTextItem
  | A2AMessageImageItem
  | A2AMessageFileItem;

export interface A2AMessageRequestPayload extends BaseRuntimeRequestPayload {
  connectorKey: string;
  externalMessageId: string;
  fromAgentKey: string;
  fromSessionId: string;
  fromThreadId: string;
  fromRunId?: string;
  toAgentKey: string;
  toSessionId: string;
  sentAt: number;
  items: readonly A2AMessageItem[];
}

export interface TelegramMessageRequestPayload extends BaseRuntimeRequestPayload {
  connectorKey: string;
  botUsername?: string | null;
  sentAt?: number;
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
  sentAt?: number;
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

export interface ResolveThreadRunConfigRequestPayload extends BaseRuntimeRequestPayload {
  threadId: string;
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

export type RuntimeRequestPayload =
  | A2AMessageRequestPayload
  | TelegramMessageRequestPayload
  | TelegramReactionRequestPayload
  | WhatsAppMessageRequestPayload
  | TuiInputRequestPayload
  | CreateBranchSessionRequestPayload
  | ResolveMainSessionThreadRequestPayload
  | ResolveThreadRunConfigRequestPayload
  | ResetSessionRequestPayload
  | AbortThreadRequestPayload
  | CompactThreadRequestPayload
  | UpdateThreadRequestPayload;

export interface CreateRuntimeRequestInput<TPayload extends RuntimeRequestPayload = RuntimeRequestPayload> {
  kind: RuntimeRequestKind;
  payload: TPayload;
}

export interface RuntimeRequestRecord<TPayload extends RuntimeRequestPayload = RuntimeRequestPayload> {
  id: string;
  kind: RuntimeRequestKind;
  status: RuntimeRequestStatus;
  payload: TPayload;
  result?: JsonValue;
  error?: string;
  claimedAt?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
}
