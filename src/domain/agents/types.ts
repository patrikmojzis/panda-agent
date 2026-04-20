import type {JsonValue} from "../../kernel/agent/types.js";

export type AgentStatus = "active" | "deleted";
export type AgentPromptSlug = "agent" | "heartbeat";

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

export interface AgentPromptRecord {
  agentKey: string;
  slug: AgentPromptSlug;
  content: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentPairingRecord {
  agentKey: string;
  identityId: string;
  metadata?: JsonValue;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSkillRecord {
  agentKey: string;
  skillKey: string;
  description: string;
  content: string;
  lastLoadedAt?: number;
  loadCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface BootstrapAgentInput extends CreateAgentInput {
  prompts?: Partial<Record<AgentPromptSlug, string>>;
}

export const MAX_AGENT_SKILL_DESCRIPTION_CHARS = 8_000;
export const MAX_AGENT_SKILL_CONTENT_CHARS = 1_000_000;

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

export function normalizeSkillKey(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Skill key must not be empty.");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error("Skill key must use lowercase letters, numbers, hyphens, or underscores.");
  }

  return normalized;
}

export function normalizeAgentSkillDescription(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Skill description must not be empty.");
  }

  if (normalized.length > MAX_AGENT_SKILL_DESCRIPTION_CHARS) {
    throw new Error(`Skill description must be at most ${MAX_AGENT_SKILL_DESCRIPTION_CHARS} characters.`);
  }

  return normalized;
}

export function normalizeAgentSkillContent(value: string): string {
  if (!value.trim()) {
    throw new Error("Skill content must not be empty.");
  }

  if (value.length > MAX_AGENT_SKILL_CONTENT_CHARS) {
    throw new Error(`Skill content must be at most ${MAX_AGENT_SKILL_CONTENT_CHARS} characters.`);
  }

  return value;
}
