import type {ThinkingLevel} from "@earendil-works/pi-ai";

import type {JsonValue} from "../../lib/json.js";
import type {InferenceProjection} from "../../kernel/transcript/types.js";

export type AgentSessionKind = "main" | "branch" | "worker" | "subagent";

export interface CreateSessionInput {
  id: string;
  agentKey: string;
  kind: AgentSessionKind;
  currentThreadId: string;
  createdByIdentityId?: string;
  alias?: string;
  displayName?: string;
  metadata?: JsonValue;
}

export interface SessionRecord extends CreateSessionInput {
  createdAt: number;
  updatedAt: number;
}

export interface ResolveSessionRefInput {
  sessionRef: string;
  agentKey?: string;
}

export interface SessionRuntimeConfigRecord {
  sessionId: string;
  model?: string;
  thinking?: ThinkingLevel;
  thinkingConfigured: boolean;
  inferenceProjection?: InferenceProjection;
  pendingWakeAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface UpdateSessionRuntimeConfigInput {
  sessionId: string;
  model?: string | null;
  thinking?: ThinkingLevel | null;
  thinkingConfigured?: boolean;
  inferenceProjection?: InferenceProjection | null;
  pendingWakeAt?: number | null;
}

export interface UpdateSessionLabelInput {
  sessionId: string;
  alias?: string | null;
  displayName?: string | null;
}

export interface UpdateSessionCurrentThreadInput {
  sessionId: string;
  currentThreadId: string;
}

export interface SessionHeartbeatRecord {
  sessionId: string;
  enabled: boolean;
  everyMinutes: number;
  nextFireAt: number;
  lastFireAt?: number;
  lastSkipReason?: string;
  claimedAt?: number;
  claimedBy?: string;
  claimExpiresAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ListDueSessionHeartbeatsInput {
  asOf?: number;
  limit?: number;
}

export interface ClaimSessionHeartbeatInput {
  sessionId: string;
  claimedBy: string;
  claimExpiresAt: number;
  asOf?: number;
}

export interface RecordSessionHeartbeatResultInput {
  sessionId: string;
  claimedBy: string;
  nextFireAt: number;
  lastFireAt?: number;
  lastSkipReason?: string | null;
}

export interface UpdateSessionHeartbeatConfigInput {
  sessionId: string;
  enabled?: boolean;
  everyMinutes?: number;
  asOf?: number;
}

export const SESSION_BRIEF_PROMPT_SLUG = "brief" as const;
export const SESSION_MEMORY_PROMPT_SLUG = "memory" as const;
export const SESSION_HEARTBEAT_PROMPT_SLUG = "heartbeat" as const;
export const SESSION_PROMPT_SLUGS = [
  SESSION_BRIEF_PROMPT_SLUG,
  SESSION_MEMORY_PROMPT_SLUG,
  SESSION_HEARTBEAT_PROMPT_SLUG,
] as const;
export type SessionPromptSlug = typeof SESSION_PROMPT_SLUGS[number];

export interface SessionPromptRecord {
  sessionId: string;
  slug: SessionPromptSlug;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface SetSessionPromptInput {
  sessionId: string;
  slug?: SessionPromptSlug;
  content: string;
}

export interface DeleteSessionPromptInput {
  sessionId: string;
  slug?: SessionPromptSlug;
}

export type SessionPromptMutation =
  | {operation: "append"; text: string}
  | {operation: "prepend"; text: string}
  | {operation: "replace"; pattern: string; replacement: string}
  | {operation: "expression"; expression: string};

export type TransformSessionPromptInput = {
  sessionId: string;
  slug?: SessionPromptSlug;
} & SessionPromptMutation;

export interface TransformSessionPromptResult {
  record: SessionPromptRecord | null;
  operation: SessionPromptMutation["operation"];
  changed: boolean;
  matchCount?: number;
}

export function normalizeSessionPromptSlug(value: string): SessionPromptSlug {
  if (SESSION_PROMPT_SLUGS.includes(value as SessionPromptSlug)) {
    return value as SessionPromptSlug;
  }

  throw new Error(`Unsupported session prompt slug ${value}.`);
}

export const DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES = 60;

export function normalizeSessionAlias(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Session alias must not be empty.");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error(
      "Session alias must use letters, numbers, hyphens, or underscores, and start with a letter or number.",
    );
  }

  return normalized;
}
