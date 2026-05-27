import type {JsonObject, JsonValue} from "../../../lib/json.js";
import type {MediaDescriptor} from "../../channels/types.js";
import type {ExecutionEnvironmentKind} from "../../execution-environments/types.js";
import type {ThinkingLevel} from "@mariozechner/pi-ai";
import type {InferenceProjection, ThreadUpdate} from "../runtime/types.js";
import type {UpdateSessionRuntimeConfigInput} from "../../sessions/types.js";

export type RuntimeRequestStatus = "pending" | "running" | "completed" | "failed";

interface BaseRuntimeRequestPayload {
  identityId?: string;
}

interface A2AMessageTextItem {
  type: "text";
  text: string;
}

interface A2AMessageImageItem {
  type: "image";
  media: MediaDescriptor;
  caption?: string;
}

interface A2AMessageFileItem {
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

export interface A2AEnvironmentPathHints {
  root?: string;
  workspace?: string;
  inbox?: string;
  artifacts?: string;
}

export interface A2ASenderEnvironmentSnapshot {
  id: string;
  kind: ExecutionEnvironmentKind;
  envDir?: string;
  parentRunnerPaths?: A2AEnvironmentPathHints;
  workerPaths?: A2AEnvironmentPathHints;
}

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
  senderEnvironment?: A2ASenderEnvironmentSnapshot;
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

export interface WhatsAppReactionRequestPayload extends BaseRuntimeRequestPayload {
  connectorKey: string;
  sentAt?: number;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  remoteJid: string;
  chatType: string;
  targetMessageId: string;
  emoji: string;
  pushName?: string;
}

export interface DiscordAttachmentSummary {
  id: string;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface DiscordMessageRequestPayload extends BaseRuntimeRequestPayload {
  connectorKey: string;
  externalConversationId: string;
  externalActorId: string;
  externalMessageId: string;
  actualChannelId: string;
  attachmentSummaries: readonly DiscordAttachmentSummary[];
  media: readonly MediaDescriptor[];
  sentAt?: number;
  guildId?: string;
  threadId?: string;
  parentChannelId?: string;
  text?: string;
  authorUsername?: string;
  authorGlobalName?: string;
  authorDisplayName?: string;
  authorIsBot?: boolean;
  replyToMessageId?: string;
  /** Reserved parser field for K8 delivery-context work; K7 does not populate/use it. */
  deliveryContext?: JsonObject;
}

export interface TuiInputRequestPayload extends BaseRuntimeRequestPayload {
  threadId?: string;
  actorId: string;
  externalMessageId: string;
  identityHandle?: string;
  sentAt?: number;
  text: string;
}

export interface CreateBranchSessionRequestPayload extends BaseRuntimeRequestPayload {
  sessionId?: string;
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

export type RuntimeRequestSubagentExecution = "agent_workspace" | "isolated_environment";

export interface CreateSubagentSessionRequestPayload extends BaseRuntimeRequestPayload {
  sessionId?: string;
  threadId?: string;
  agentKey?: string;
  parentSessionId: string;
  prompt: string;
  context?: string;
  profile?: string;
  execution?: RuntimeRequestSubagentExecution;
  environmentId?: string;
  credentialAllowlist?: readonly string[];
  toolGroups?: readonly string[];
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

/** Storage compatibility only: stale persisted rows are claimed and failed by the daemon. */
export interface LegacyCreateWorkerSessionRequestPayload extends BaseRuntimeRequestPayload {
  [key: string]: JsonValue | undefined;
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
  source: string;
  sessionId?: string;
  threadId?: string;
  connectorKey?: string;
  externalConversationId?: string;
  externalActorId?: string;
  externalMessageId?: string;
  /** Legacy persisted name for channel reset command messages. New callers use externalMessageId. */
  commandExternalMessageId?: string;
  agentKey?: string;
  model?: string;
  thinking?: ThinkingLevel;
  inferenceProjection?: InferenceProjection;
}

export type ResetSessionResult = Record<string, unknown> & {
  threadId: string;
  previousThreadId: string;
  sessionId: string;
};

export interface AbortThreadRequestPayload extends BaseRuntimeRequestPayload {
  threadId: string;
  reason?: string;
}

export interface CompactThreadRequestPayload extends BaseRuntimeRequestPayload {
  threadId: string;
  customInstructions: string;
}

export type RuntimeThreadUpdate = ThreadUpdate & Omit<UpdateSessionRuntimeConfigInput, "sessionId">;

export interface UpdateThreadRequestPayload extends BaseRuntimeRequestPayload {
  threadId: string;
  update: RuntimeThreadUpdate;
}

export interface RuntimeRequestPayloadByKind {
  a2a_message: A2AMessageRequestPayload;
  telegram_message: TelegramMessageRequestPayload;
  telegram_reaction: TelegramReactionRequestPayload;
  whatsapp_message: WhatsAppMessageRequestPayload;
  whatsapp_reaction: WhatsAppReactionRequestPayload;
  discord_message: DiscordMessageRequestPayload;
  tui_input: TuiInputRequestPayload;
  create_branch_session: CreateBranchSessionRequestPayload;
  create_subagent_session: CreateSubagentSessionRequestPayload;
  create_worker_session: LegacyCreateWorkerSessionRequestPayload;
  resolve_main_session_thread: ResolveMainSessionThreadRequestPayload;
  resolve_thread_run_config: ResolveThreadRunConfigRequestPayload;
  reset_session: ResetSessionRequestPayload;
  abort_thread: AbortThreadRequestPayload;
  compact_thread: CompactThreadRequestPayload;
  update_thread: UpdateThreadRequestPayload;
}

export type RuntimeRequestKind = keyof RuntimeRequestPayloadByKind;
export type RuntimeRequestPayload = RuntimeRequestPayloadByKind[RuntimeRequestKind];

export type CreateRuntimeRequestInput<K extends RuntimeRequestKind = RuntimeRequestKind> = {
  [Kind in K]: {
    kind: Kind;
    payload: RuntimeRequestPayloadByKind[Kind];
  };
}[K];

type RuntimeRequestRecordForKind<K extends RuntimeRequestKind> = {
  id: string;
  kind: K;
  status: RuntimeRequestStatus;
  payload: RuntimeRequestPayloadByKind[K];
  result?: JsonValue;
  error?: string;
  claimedAt?: number;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
};

export type RuntimeRequestRecord<K extends RuntimeRequestKind = RuntimeRequestKind> = {
  [Kind in K]: RuntimeRequestRecordForKind<Kind>;
}[K];
