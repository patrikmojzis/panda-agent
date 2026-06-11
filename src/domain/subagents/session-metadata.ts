import type {ThinkingLevel} from "@earendil-works/pi-ai";

import type {
  ExecutionCredentialPolicy,
  ExecutionSkillPolicy,
  ExecutionToolPolicy,
} from "../execution-environments/types.js";
import type {JsonObject, JsonValue} from "../../lib/json.js";
import {isJsonObject, normalizeToJsonValue} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {normalizeAgentSkillOperations} from "../execution-environments/policy.js";
import {requireNonEmptyString, trimToUndefined, uniqueTrimmedStrings} from "../../lib/strings.js";
import {
  normalizeSubagentProfileDescription,
  normalizeSubagentProfilePrompt,
  normalizeSubagentProfileSlug,
  parseSubagentProfileThinking,
  parseSubagentProfileTranscriptMode,
  type SubagentProfileRecord,
  type SubagentProfileSource,
  type SubagentProfileTranscriptMode,
} from "./types.js";
import {normalizeSubagentToolGroups, type SubagentToolGroup} from "./tool-groups.js";

export const SUBAGENT_SESSION_METADATA_VERSION = 1;

export type SubagentExecutionMode = "agent_workspace" | "isolated_environment";
export type SubagentProfileSnapshotSource = SubagentProfileSource | "ad_hoc";
export type SubagentResolvedModelSource = "spawn" | "profile";

export interface SubagentProfileSnapshot {
  slug: string;
  source: SubagentProfileSnapshotSource;
  description: string;
  prompt: string;
  toolGroups: readonly SubagentToolGroup[];
  model?: string;
  thinking?: ThinkingLevel;
  transcriptMode: SubagentProfileTranscriptMode;
}

export interface SubagentResolvedSnapshot {
  model?: string;
  modelSource?: SubagentResolvedModelSource;
  thinking?: ThinkingLevel;
  credentialPolicy: ExecutionCredentialPolicy;
  skillPolicy: ExecutionSkillPolicy;
  toolPolicy: ExecutionToolPolicy;
}

export interface SubagentSessionMetadata {
  version: typeof SUBAGENT_SESSION_METADATA_VERSION;
  role: string;
  task: string;
  context?: string;
  parentSessionId: string;
  execution: SubagentExecutionMode;
  environmentId?: string;
  profile: SubagentProfileSnapshot;
  resolved: SubagentResolvedSnapshot;
}

export interface BuildSubagentSessionMetadataInput {
  role: string;
  task: string;
  context?: string;
  parentSessionId: string;
  execution: SubagentExecutionMode;
  environmentId?: string;
  profile: SubagentProfileSnapshot;
  resolved: SubagentResolvedSnapshot;
}

function compactJsonObject(value: Record<string, unknown>): JsonObject {
  const compacted = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
  const json = normalizeToJsonValue(compacted);
  if (!isJsonObject(json)) {
    throw new Error("Subagent metadata must be a JSON object.");
  }
  return json;
}

function requireMetadataString(value: unknown, field: string): string {
  return requireNonEmptyString(value, `Subagent metadata ${field} must not be empty.`);
}

function parseExecutionMode(value: unknown): SubagentExecutionMode {
  if (value === "agent_workspace" || value === "isolated_environment") {
    return value;
  }
  throw new Error(`Unsupported subagent execution mode ${String(value)}.`);
}

function parseProfileSource(value: unknown): SubagentProfileSnapshotSource {
  if (value === "builtin" || value === "custom" || value === "ad_hoc") {
    return value;
  }
  throw new Error(`Unsupported subagent metadata profile source ${String(value)}.`);
}

function parseModelSource(value: unknown): SubagentResolvedModelSource | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "spawn" || value === "profile") {
    return value;
  }
  throw new Error(`Unsupported subagent metadata model source ${String(value)}.`);
}

function parseCredentialPolicy(value: unknown): ExecutionCredentialPolicy {
  if (!isRecord(value)) {
    throw new Error("Subagent metadata credential policy must be an object.");
  }
  if (value.mode === "all_agent" || value.mode === "none") {
    return {mode: value.mode};
  }
  if (value.mode === "allowlist") {
    return {
      mode: "allowlist",
      envKeys: Array.isArray(value.envKeys)
        ? uniqueTrimmedStrings(value.envKeys.filter((entry): entry is string => typeof entry === "string"))
        : [],
    };
  }
  throw new Error(`Unsupported subagent metadata credential policy ${String(value.mode)}.`);
}

function parseSkillPolicy(value: unknown): ExecutionSkillPolicy {
  if (!isRecord(value)) {
    throw new Error("Subagent metadata skill policy must be an object.");
  }
  if (value.mode === "all_agent" || value.mode === "none") {
    return {mode: value.mode};
  }
  if (value.mode === "allowlist") {
    return {
      mode: "allowlist",
      skillKeys: Array.isArray(value.skillKeys)
        ? uniqueTrimmedStrings(value.skillKeys.filter((entry): entry is string => typeof entry === "string"))
        : [],
    };
  }
  throw new Error(`Unsupported subagent metadata skill policy ${String(value.mode)}.`);
}

function parseAllowedTools(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const allowedTools = uniqueTrimmedStrings(value.filter((entry): entry is string => typeof entry === "string"));
  return allowedTools.length > 0 ? allowedTools : undefined;
}

function parseToolPolicy(value: unknown): ExecutionToolPolicy {
  if (!isRecord(value)) {
    throw new Error("Subagent metadata tool policy must be an object.");
  }

  const allowedTools = parseAllowedTools(value.allowedTools);
  const policy: ExecutionToolPolicy = {
    ...(allowedTools ? {allowedTools} : {}),
  };
  if (isRecord(value.bash) && typeof value.bash.allowed === "boolean") {
    policy.bash = {allowed: value.bash.allowed};
  }
  if (isRecord(value.postgresReadonly) && typeof value.postgresReadonly.allowed === "boolean") {
    policy.postgresReadonly = {allowed: value.postgresReadonly.allowed};
  }
  if (isRecord(value.agentSkill)) {
    policy.agentSkill = {
      allowedOperations: Array.isArray(value.agentSkill.allowedOperations)
        ? normalizeAgentSkillOperations(value.agentSkill.allowedOperations)
        : [],
    };
  }
  return policy;
}

export function buildSubagentProfileSnapshot(profile: SubagentProfileRecord): SubagentProfileSnapshot {
  return {
    slug: profile.slug,
    source: profile.source,
    description: profile.description,
    prompt: profile.prompt,
    toolGroups: [...profile.toolGroups],
    ...(profile.model ? {model: profile.model} : {}),
    ...(profile.thinking ? {thinking: profile.thinking} : {}),
    transcriptMode: profile.transcriptMode,
  };
}

export function buildAdHocSubagentProfileSnapshot(toolGroups: readonly SubagentToolGroup[]): SubagentProfileSnapshot {
  return {
    slug: "ad_hoc",
    source: "ad_hoc",
    description: "Ad-hoc scoped subagent profile.",
    prompt: "You are a scoped subagent. Follow the handoff and available tools.",
    toolGroups: [...toolGroups],
    transcriptMode: "none",
  };
}

export function buildSubagentSessionMetadata(input: BuildSubagentSessionMetadataInput): JsonObject {
  const context = trimToUndefined(input.context);
  const environmentId = trimToUndefined(input.environmentId);
  const subagent = compactJsonObject({
    version: SUBAGENT_SESSION_METADATA_VERSION,
    role: requireMetadataString(input.role, "role"),
    task: requireMetadataString(input.task, "task"),
    ...(context ? {context} : {}),
    parentSessionId: requireMetadataString(input.parentSessionId, "parentSessionId"),
    execution: input.execution,
    ...(environmentId ? {environmentId} : {}),
    profile: input.profile,
    resolved: input.resolved,
  });

  return {subagent};
}

function parseProfileSnapshot(value: unknown): SubagentProfileSnapshot {
  if (!isRecord(value)) {
    throw new Error("Subagent metadata profile snapshot must be an object.");
  }
  return {
    slug: normalizeSubagentProfileSlug(requireMetadataString(value.slug, "profile.slug")),
    source: parseProfileSource(value.source),
    description: normalizeSubagentProfileDescription(requireMetadataString(value.description, "profile.description")),
    prompt: normalizeSubagentProfilePrompt(requireMetadataString(value.prompt, "profile.prompt")),
    toolGroups: normalizeSubagentToolGroups(Array.isArray(value.toolGroups)
      ? value.toolGroups.filter((entry): entry is string => typeof entry === "string")
      : []),
    model: trimToUndefined(value.model),
    thinking: parseSubagentProfileThinking(value.thinking),
    transcriptMode: parseSubagentProfileTranscriptMode(value.transcriptMode),
  };
}

function parseResolvedSnapshot(value: unknown): SubagentResolvedSnapshot {
  if (!isRecord(value)) {
    throw new Error("Subagent metadata resolved snapshot must be an object.");
  }
  return {
    model: trimToUndefined(value.model),
    modelSource: parseModelSource(value.modelSource),
    thinking: parseSubagentProfileThinking(value.thinking),
    credentialPolicy: parseCredentialPolicy(value.credentialPolicy),
    skillPolicy: parseSkillPolicy(value.skillPolicy),
    toolPolicy: parseToolPolicy(value.toolPolicy),
  };
}

export function readSubagentSessionMetadata(metadata: JsonValue | undefined): SubagentSessionMetadata | null {
  if (metadata === undefined) {
    return null;
  }
  if (!isRecord(metadata) || metadata.subagent === undefined) {
    return null;
  }
  const value = metadata.subagent;
  if (!isRecord(value)) {
    throw new Error("Subagent metadata must be an object.");
  }
  if (value.version !== SUBAGENT_SESSION_METADATA_VERSION) {
    throw new Error(`Unsupported subagent metadata version ${String(value.version)}.`);
  }

  const execution = parseExecutionMode(value.execution);
  const environmentId = trimToUndefined(value.environmentId);
  if (execution === "isolated_environment" && !environmentId) {
    throw new Error("Isolated subagent metadata must include environmentId.");
  }

  return {
    version: SUBAGENT_SESSION_METADATA_VERSION,
    role: requireMetadataString(value.role, "role"),
    task: requireMetadataString(value.task, "task"),
    context: trimToUndefined(value.context),
    parentSessionId: requireMetadataString(value.parentSessionId, "parentSessionId"),
    execution,
    ...(environmentId ? {environmentId} : {}),
    profile: parseProfileSnapshot(value.profile),
    resolved: parseResolvedSnapshot(value.resolved),
  };
}
