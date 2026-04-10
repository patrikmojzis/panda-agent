import type {JsonValue} from "../agent-core/types.js";

export type AgentStatus = "active" | "deleted";
export type AgentDocumentSlug = "agent" | "soul" | "heartbeat" | "playbook";
export type RelationshipDocumentSlug = "memory";

export interface CreateAgentInput {
  agentKey: string;
  displayName: string;
  status?: AgentStatus;
  metadata?: JsonValue;
}

export interface AgentRecord extends CreateAgentInput {
  status: AgentStatus;
  createdAt: number;
  updatedAt: number;
}

export interface AgentDocumentRecord {
  agentKey: string;
  slug: AgentDocumentSlug;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface RelationshipDocumentRecord {
  agentKey: string;
  identityId: string;
  slug: RelationshipDocumentSlug;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentDiaryRecord {
  agentKey: string;
  identityId: string;
  entryDate: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface BootstrapAgentInput extends CreateAgentInput {
  documents: Record<AgentDocumentSlug, string>;
}

export function normalizeAgentKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Agent key must not be empty.");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error("Agent key must use lowercase letters, numbers, hyphens, or underscores.");
  }

  return normalized;
}
