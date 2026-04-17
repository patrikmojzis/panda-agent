import {resolveModelSelector} from "../kernel/agent/index.js";
import {resolveRuntimeDefaultModelSelector} from "../kernel/models/default-model.js";

export function resolveDefaultAgentModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return resolveRuntimeDefaultModelSelector(env);
}

export function resolveDefaultAgentWorkspaceSubagentModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.WORKSPACE_SUBAGENT_MODEL?.trim();
  return configured ? resolveModelSelector(configured).canonical : undefined;
}

export function resolveDefaultAgentMemorySubagentModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.MEMORY_SUBAGENT_MODEL?.trim();
  return configured ? resolveModelSelector(configured).canonical : undefined;
}

export function resolveDefaultAgentBrowserSubagentModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.BROWSER_SUBAGENT_MODEL?.trim();
  return configured ? resolveModelSelector(configured).canonical : undefined;
}

export function resolveDefaultAgentSkillMaintainerSubagentModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.SKILL_MAINTAINER_SUBAGENT_MODEL?.trim();
  return configured ? resolveModelSelector(configured).canonical : undefined;
}
