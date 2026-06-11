import type {ThinkingLevel} from "@earendil-works/pi-ai";

import {normalizeAgentKey} from "../agents/types.js";
import {requireNonEmptyString, trimToUndefined} from "../../lib/strings.js";
import {
  normalizeSubagentToolGroups,
  type SubagentToolGroup,
} from "./tool-groups.js";

export const MAX_SUBAGENT_PROFILE_DESCRIPTION_CHARS = 255;
export const SUBAGENT_PROFILE_SOURCES = ["builtin", "custom"] as const;
export const SUBAGENT_PROFILE_TRANSCRIPT_MODES = ["none"] as const;
export const SUBAGENT_PROFILE_THINKING_LEVELS = ["low", "medium", "high", "xhigh"] as const;

export type SubagentProfileSource = typeof SUBAGENT_PROFILE_SOURCES[number];
export type SubagentProfileTranscriptMode = typeof SUBAGENT_PROFILE_TRANSCRIPT_MODES[number];

export interface SubagentProfileRecord {
  slug: string;
  agentKey?: string;
  description: string;
  prompt: string;
  toolGroups: readonly SubagentToolGroup[];
  model?: string;
  thinking?: ThinkingLevel;
  transcriptMode: SubagentProfileTranscriptMode;
  source: SubagentProfileSource;
  createdByAgentKey?: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertSubagentProfileInput {
  slug: string;
  agentKey?: string | null;
  description: string;
  prompt: string;
  toolGroups: readonly string[];
  model?: string | null;
  thinking?: ThinkingLevel | null;
  transcriptMode?: SubagentProfileTranscriptMode | null;
  source: SubagentProfileSource;
  createdByAgentKey?: string | null;
  enabled?: boolean;
}

export interface ListSubagentProfilesInput {
  agentKey?: string;
  includeDisabled?: boolean;
}

export interface GetSubagentProfileInput extends ListSubagentProfilesInput {
  slug: string;
}

export interface SetSubagentProfileEnabledInput {
  slug: string;
  agentKey: string;
  enabled: boolean;
}

export type NormalizedSubagentProfileInput = Omit<SubagentProfileRecord, "createdAt" | "updatedAt">;

const FORBIDDEN_SUBAGENT_PROFILE_FIELDS = new Set([
  "toolNames",
  "tools",
  "toolAllowlist",
  "credentialAllowlist",
  "credentials",
  "credentialPolicy",
  "environmentId",
  "environmentIds",
  "execution",
  "env",
  "envIds",
  "skillAllowlist",
]);

const THINKING_LEVEL_SET = new Set<string>(SUBAGENT_PROFILE_THINKING_LEVELS);

export function normalizeSubagentProfileSlug(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    throw new Error("Subagent profile slug must not be empty.");
  }

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
    throw new Error("Subagent profile slug must use lowercase letters, numbers, hyphens, or underscores.");
  }

  return normalized;
}

export function normalizeSubagentProfileDescription(value: string): string {
  const normalized = requireNonEmptyString(value, "Subagent profile description must not be empty.");
  if (normalized.length > MAX_SUBAGENT_PROFILE_DESCRIPTION_CHARS) {
    throw new Error(
      `Subagent profile description must be at most ${MAX_SUBAGENT_PROFILE_DESCRIPTION_CHARS} characters.`,
    );
  }

  return normalized;
}

export function normalizeSubagentProfilePrompt(value: string): string {
  return requireNonEmptyString(value, "Subagent profile prompt must not be empty.");
}

export function parseSubagentProfileSource(value: unknown): SubagentProfileSource {
  if (value === "builtin" || value === "custom") {
    return value;
  }

  throw new Error(`Unsupported subagent profile source ${String(value)}.`);
}

export function parseSubagentProfileTranscriptMode(value: unknown): SubagentProfileTranscriptMode {
  if (value === undefined || value === null || value === "none") {
    return "none";
  }

  throw new Error(`Unsupported subagent profile transcript mode ${String(value)}.`);
}

export function parseSubagentProfileThinking(value: unknown): ThinkingLevel | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value === "string" && THINKING_LEVEL_SET.has(value)) {
    return value as ThinkingLevel;
  }

  throw new Error(`Unsupported subagent profile thinking level ${String(value)}.`);
}

export function assertNoForbiddenSubagentProfileFields(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!FORBIDDEN_SUBAGENT_PROFILE_FIELDS.has(key)) {
      continue;
    }

    throw new Error(`Subagent profiles must not store ${key}. Pass it on spawn instead.`);
  }
}

export function normalizeSubagentProfileInput(
  input: UpsertSubagentProfileInput,
): NormalizedSubagentProfileInput {
  assertNoForbiddenSubagentProfileFields(input as unknown as Record<string, unknown>);

  const source = parseSubagentProfileSource(input.source);
  const agentKey = input.agentKey === null ? undefined : trimToUndefined(input.agentKey);
  const createdByAgentKey = input.createdByAgentKey === null
    ? undefined
    : trimToUndefined(input.createdByAgentKey);

  if (source === "builtin" && agentKey !== undefined) {
    throw new Error("Built-in subagent profiles must be global and cannot set agentKey.");
  }
  if (source === "builtin" && createdByAgentKey !== undefined) {
    throw new Error("Built-in subagent profiles must not set createdByAgentKey.");
  }
  if (source === "custom" && agentKey === undefined) {
    throw new Error("Custom subagent profiles must set agentKey.");
  }
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new Error("Subagent profile enabled must be a boolean.");
  }

  const toolGroups = normalizeSubagentToolGroups(input.toolGroups);
  if (toolGroups.length === 0) {
    throw new Error("Subagent profile toolGroups must contain at least one group.");
  }

  return {
    slug: normalizeSubagentProfileSlug(input.slug),
    agentKey: agentKey === undefined ? undefined : normalizeAgentKey(agentKey),
    description: normalizeSubagentProfileDescription(input.description),
    prompt: normalizeSubagentProfilePrompt(input.prompt),
    toolGroups,
    model: trimToUndefined(input.model),
    thinking: parseSubagentProfileThinking(input.thinking),
    transcriptMode: parseSubagentProfileTranscriptMode(input.transcriptMode),
    source,
    createdByAgentKey: createdByAgentKey === undefined ? undefined : normalizeAgentKey(createdByAgentKey),
    enabled: input.enabled ?? true,
  };
}
