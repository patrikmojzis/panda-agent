import {resolveModelSelector} from "../kernel/models/model-selector.js";
import {resolveRuntimeDefaultModelSelector} from "../kernel/models/default-model.js";
import type {DefaultAgentSubagentRole} from "./subagents/policy.js";

const DEFAULT_AGENT_SUBAGENT_MODEL_ENV_KEYS: Record<DefaultAgentSubagentRole, string> = {
  workspace: "WORKSPACE_SUBAGENT_MODEL",
  memory: "MEMORY_SUBAGENT_MODEL",
  browser: "BROWSER_SUBAGENT_MODEL",
  skill_maintainer: "SKILL_MAINTAINER_SUBAGENT_MODEL",
};

export function resolveDefaultAgentModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveRuntimeDefaultModelSelector(env);
}

function resolveOptionalModelSelector(
  env: NodeJS.ProcessEnv,
  envKey: string,
): string | undefined {
  const configured = env[envKey]?.trim();
  return configured ? resolveModelSelector(configured).canonical : undefined;
}

export function resolveDefaultAgentSubagentModelSelector(
  role: DefaultAgentSubagentRole,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveOptionalModelSelector(env, DEFAULT_AGENT_SUBAGENT_MODEL_ENV_KEYS[role]);
}
