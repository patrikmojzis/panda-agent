import type {JsonValue} from "../../kernel/agent/types.js";

export type AgentSessionKind = "main" | "branch" | "worker";

export interface CreateSessionInput {
  id: string;
  agentKey: string;
  kind: AgentSessionKind;
  currentThreadId: string;
  createdByIdentityId?: string;
  metadata?: JsonValue;
}

export interface SessionRecord extends CreateSessionInput {
  createdAt: number;
  updatedAt: number;
}

export interface ListAgentSessionsInput {
  agentKey: string;
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

export const DEFAULT_SESSION_HEARTBEAT_EVERY_MINUTES = 60;
