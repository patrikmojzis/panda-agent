import type {AgentSkillOperation, ExecutionToolPolicy} from "../execution-environments/types.js";
import {normalizeAgentSkillOperations} from "../execution-environments/policy.js";
import {uniqueTrimmedStrings} from "../../lib/strings.js";
import {commandNamesForToolGroups, type CommandCatalog} from "../commands/modules.js";
import type {CommandPolicyModule} from "../commands/types.js";

const ALL_AGENT_SKILL_OPERATIONS: readonly AgentSkillOperation[] = ["load", "set", "patch", "delete"];

interface SubagentToolGroupDefinition {
  description: string;
  nativeToolNames: readonly string[];
  agentSkillOperations?: readonly AgentSkillOperation[];
  bash?: {allowed: true};
  postgresReadonly?: {allowed: true};
}

export const SUBAGENT_TOOL_GROUP_DEFINITIONS = {
  core: {
    description: "Universal command transport, local artifact preview, and parent A2A updates.",
    nativeToolNames: [
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
      "view_media",
    ],
    agentSkillOperations: ["load"],
  },
  internet: {
    description: "Public web lookup, research, and browser inspection.",
    nativeToolNames: [
      "browser",
    ],
  },
  memory: {
    description: "Durable Panda memory and wiki operations.",
    nativeToolNames: [],
    postgresReadonly: {allowed: true},
  },
  execute: {
    description: "Active runtime execution and background job control.",
    nativeToolNames: [
      "bash",
      "background_job_status",
      "background_job_wait",
      "background_job_cancel",
    ],
    bash: {allowed: true},
  },
  skill_maintenance: {
    description: "Narrow durable skill load/create/patch/delete access without broad operational tools.",
    nativeToolNames: [],
    agentSkillOperations: ALL_AGENT_SKILL_OPERATIONS,
  },
  operate: {
    description: "Operational mutation and control surfaces.",
    nativeToolNames: [
      "thinking_set",
    ],
    agentSkillOperations: ALL_AGENT_SKILL_OPERATIONS,
  },
  communicate_human: {
    description: "Human/channel outbound communication surfaces.",
    nativeToolNames: [],
  },
  mcp: {
    description: "Configured Model Context Protocol server tool discovery and calls.",
    nativeToolNames: [],
  },
} as const satisfies Record<string, SubagentToolGroupDefinition>;

export type SubagentToolGroup = keyof typeof SUBAGENT_TOOL_GROUP_DEFINITIONS;

export const SUBAGENT_TOOL_GROUP_KEYS = Object.keys(
  SUBAGENT_TOOL_GROUP_DEFINITIONS,
) as SubagentToolGroup[];

const SUBAGENT_TOOL_GROUP_KEY_SET = new Set<string>(SUBAGENT_TOOL_GROUP_KEYS);

export function isSubagentToolGroup(value: unknown): value is SubagentToolGroup {
  return typeof value === "string" && SUBAGENT_TOOL_GROUP_KEY_SET.has(value);
}

export function normalizeSubagentToolGroups(values: readonly string[]): SubagentToolGroup[] {
  const normalized = uniqueTrimmedStrings(values);
  const unknown = normalized.filter((value) => !isSubagentToolGroup(value));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown subagent tool group ${JSON.stringify(unknown[0])}. Expected one of: ${SUBAGENT_TOOL_GROUP_KEYS.join(", ")}.`,
    );
  }

  return normalized as SubagentToolGroup[];
}

/** Strip no-op historical groups when reading durable records from before the hard cut. */
export function normalizePersistedSubagentToolGroups(values: readonly string[]): SubagentToolGroup[] {
  return normalizeSubagentToolGroups(values.filter((value) => value !== "workspace_read"));
}

export interface ExpandSubagentToolGroupsOptions {
  commandCatalog?: Pick<CommandCatalog, "namesForToolGroups">;
  commandModules?: readonly CommandPolicyModule[];
}

function commandNamesForGroups(
  options: ExpandSubagentToolGroupsOptions,
  groups: readonly string[],
): string[] {
  if (options.commandCatalog && options.commandModules) {
    throw new Error("Pass either commandCatalog or commandModules, not both.");
  }
  if (options.commandCatalog) {
    return options.commandCatalog.namesForToolGroups(groups);
  }

  return commandNamesForToolGroups(options.commandModules ?? [], groups);
}

export function expandSubagentToolGroups(
  groups: readonly SubagentToolGroup[],
  options: ExpandSubagentToolGroupsOptions = {},
): string[] {
  const normalizedGroups = normalizeSubagentToolGroups(groups);
  return uniqueTrimmedStrings(normalizedGroups.flatMap((group) => [
    ...SUBAGENT_TOOL_GROUP_DEFINITIONS[group].nativeToolNames,
    ...commandNamesForGroups(options, [group]),
  ]));
}

export function resolveSubagentToolPolicy(
  groups: readonly SubagentToolGroup[],
  options: ExpandSubagentToolGroupsOptions = {},
): ExecutionToolPolicy {
  const normalizedGroups = normalizeSubagentToolGroups(groups);
  const allowedTools = expandSubagentToolGroups(normalizedGroups, options);
  const agentSkillOperations = normalizeAgentSkillOperations(normalizedGroups.flatMap((group) => {
    const definition = SUBAGENT_TOOL_GROUP_DEFINITIONS[group];
    return "agentSkillOperations" in definition ? [...definition.agentSkillOperations] : [];
  }));
  const grantsBash = normalizedGroups.some((group) => {
    const definition = SUBAGENT_TOOL_GROUP_DEFINITIONS[group];
    return "bash" in definition && definition.bash.allowed === true;
  });
  const grantsPostgresReadonly = normalizedGroups.some((group) => {
    const definition = SUBAGENT_TOOL_GROUP_DEFINITIONS[group];
    return "postgresReadonly" in definition && definition.postgresReadonly.allowed === true;
  });

  return {
    ...(allowedTools.length > 0 ? {allowedTools} : {}),
    ...(grantsBash ? {bash: {allowed: true}} : {}),
    ...(grantsPostgresReadonly ? {postgresReadonly: {allowed: true}} : {}),
    ...(agentSkillOperations.length > 0
      ? {agentSkill: {allowedOperations: agentSkillOperations}}
      : {}),
  };
}

export function describeSubagentToolGroups(
  options: ExpandSubagentToolGroupsOptions = {},
): Record<SubagentToolGroup, Omit<SubagentToolGroupDefinition, "nativeToolNames"> & {toolNames: string[]}> {
  return Object.fromEntries(SUBAGENT_TOOL_GROUP_KEYS.map((group) => {
    const definition = SUBAGENT_TOOL_GROUP_DEFINITIONS[group];
    return [group, {
      description: definition.description,
      ...("agentSkillOperations" in definition ? {agentSkillOperations: definition.agentSkillOperations} : {}),
      ...("bash" in definition ? {bash: definition.bash} : {}),
      ...("postgresReadonly" in definition ? {postgresReadonly: definition.postgresReadonly} : {}),
      toolNames: expandSubagentToolGroups([group], options),
    }];
  })) as Record<SubagentToolGroup, Omit<SubagentToolGroupDefinition, "nativeToolNames"> & {toolNames: string[]}>;
}
