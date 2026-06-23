import {normalizeSkillKey} from "../agents/types.js";
import {isRecord} from "../../lib/records.js";
import {uniqueTrimmedStrings} from "../../lib/strings.js";
import type {AgentSkillOperation, ExecutionSkillPolicy, ExecutionToolPolicy} from "./types.js";

const AGENT_SKILL_OPERATIONS: readonly AgentSkillOperation[] = ["load", "set", "update_description", "delete"];
const AGENT_SKILL_OPERATION_SET = new Set<string>(AGENT_SKILL_OPERATIONS);

export function normalizeAgentSkillOperations(values: readonly unknown[]): AgentSkillOperation[] {
  return uniqueTrimmedStrings(values.flatMap((value) => {
    if (typeof value !== "string") {
      return [];
    }
    const normalized = value.trim();
    if (!AGENT_SKILL_OPERATION_SET.has(normalized)) {
      return [];
    }
    return [normalized];
  })) as AgentSkillOperation[];
}

export function readExecutionSkillPolicy(context: unknown): ExecutionSkillPolicy {
  if (isRecord(context) && isRecord(context.executionEnvironment)) {
    const policy = context.executionEnvironment.skillPolicy;
    if (isRecord(policy)) {
      if (policy.mode === "all_agent" || policy.mode === "none") {
        return {mode: policy.mode};
      }
      if (policy.mode === "allowlist") {
        const skillKeys = Array.isArray(policy.skillKeys)
          ? uniqueTrimmedStrings(policy.skillKeys.flatMap((key) => {
            if (typeof key !== "string" || !key.trim()) {
              return [];
            }
            return [normalizeSkillKey(key)];
          }))
          : [];
        return {
          mode: "allowlist",
          skillKeys,
        };
      }
    }
  }

  return {mode: "all_agent"};
}

export function isExecutionSkillAllowed(policy: ExecutionSkillPolicy, skillKey: string): boolean {
  if (policy.mode === "all_agent") {
    return true;
  }
  if (policy.mode === "none") {
    return false;
  }

  const normalized = normalizeSkillKey(skillKey);
  return policy.skillKeys.some((key) => normalizeSkillKey(key) === normalized);
}

function readRuntimeToolPolicy(context: unknown): ExecutionToolPolicy | undefined {
  if (!isRecord(context) || !isRecord(context.executionEnvironment)) {
    return undefined;
  }
  const policy = context.executionEnvironment.toolPolicy;
  return isRecord(policy) ? policy as ExecutionToolPolicy : undefined;
}

function isSubagentRuntimeContext(context: unknown): boolean {
  return isRecord(context) && context.sessionKind === "subagent";
}

export function readExecutionAgentSkillAllowedOperations(context: unknown): readonly AgentSkillOperation[] | undefined {
  const policy = readRuntimeToolPolicy(context);
  const agentSkill = policy?.agentSkill;
  if (isRecord(agentSkill)) {
    const allowedOperations = Array.isArray(agentSkill.allowedOperations)
      ? normalizeAgentSkillOperations(agentSkill.allowedOperations)
      : [];
    return allowedOperations;
  }

  return isSubagentRuntimeContext(context) ? [] : undefined;
}

export function isExecutionAgentSkillOperationAllowed(
  context: unknown,
  operation: AgentSkillOperation,
): boolean {
  const allowedOperations = readExecutionAgentSkillAllowedOperations(context);
  if (allowedOperations === undefined) {
    return true;
  }

  return allowedOperations.includes(operation);
}

function normalizeToolName(value: string): string {
  return value.trim();
}

function readAllowedToolSet(policy: ExecutionToolPolicy | undefined): Set<string> | null {
  const allowedTools = policy?.allowedTools
    ?.map(normalizeToolName)
    .filter(Boolean);
  return allowedTools && allowedTools.length > 0 ? new Set(allowedTools) : null;
}

export function isExecutionToolAllowedByPolicy(
  policy: ExecutionToolPolicy | undefined,
  toolName: string,
  options: {requireAllowlist?: boolean} = {},
): boolean {
  const normalizedToolName = normalizeToolName(toolName);
  if (!normalizedToolName) {
    return false;
  }

  const allowedTools = readAllowedToolSet(policy);
  if (options.requireAllowlist && !allowedTools) {
    return false;
  }
  if (allowedTools && !allowedTools.has(normalizedToolName)) {
    return false;
  }
  if (normalizedToolName === "bash" && policy?.bash?.allowed === false) {
    return false;
  }
  if (normalizedToolName === "postgres_readonly_query" && policy?.postgresReadonly?.allowed === false) {
    return false;
  }

  return true;
}
