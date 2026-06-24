import type {JsonValue} from "../../lib/json.js";

export type AgentStatus = "active" | "deleted";

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
  tags: readonly string[];
  agentEditable: boolean;
  lastLoadedAt?: number;
  loadCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface SetAgentSkillOptions {
  agentEditable?: boolean;
}

export class AgentSkillNotEditableError extends Error {
  constructor() {
    super("Skill is locked from agent edits.");
    this.name = "AgentSkillNotEditableError";
  }
}

export interface BootstrapAgentInput extends CreateAgentInput {}

export const MAX_AGENT_SKILL_DESCRIPTION_CHARS = 255;
export const MAX_AGENT_SKILL_CONTENT_CHARS = 1_000_000;
export const MAX_AGENT_SKILL_TAGS = 20;
export const MAX_AGENT_SKILL_TAG_CHARS = 64;

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

export function normalizePersistedAgentSkillDescription(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("Skill description must not be empty.");
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

export function normalizeAgentSkillTag(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Skill tags must be strings.");
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Skill tags must not be empty.");
  }

  if (normalized.length > MAX_AGENT_SKILL_TAG_CHARS) {
    throw new Error(`Skill tags must be at most ${MAX_AGENT_SKILL_TAG_CHARS} characters.`);
  }

  if (!/^[a-z0-9][a-z0-9:_-]*$/.test(normalized)) {
    throw new Error("Skill tags must use lowercase letters, numbers, hyphens, underscores, or colons.");
  }

  return normalized;
}

export function normalizeAgentSkillTags(values: readonly unknown[] = []): string[] {
  if (values.length > MAX_AGENT_SKILL_TAGS) {
    throw new Error(`Skills can have at most ${MAX_AGENT_SKILL_TAGS} tags.`);
  }

  const tags: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const tag = normalizeAgentSkillTag(value);
    if (seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    tags.push(tag);
  }

  return tags;
}
