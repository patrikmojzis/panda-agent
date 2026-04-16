import {
    buildCanonicalModelSelector,
    getProviderConfig,
    hasAnthropicOauthToken,
    hasOpenAICodexOauthToken,
    type ProviderName,
    resolveModelSelector,
} from "../kernel/agent/index.js";

function resolveDefaultAgentProvider(env: NodeJS.ProcessEnv = process.env): ProviderName {
  if (hasAnthropicOauthToken(env) && !env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    return "anthropic-oauth";
  }

  if (hasOpenAICodexOauthToken({ env }) && !env.OPENAI_API_KEY) {
    return "openai-codex";
  }

  if (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    return "anthropic";
  }

  return "openai";
}

export function resolveDefaultAgentModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.DEFAULT_MODEL?.trim();
  if (configured) {
    return resolveModelSelector(configured).canonical;
  }

  const provider = resolveDefaultAgentProvider(env);
  const config = getProviderConfig(provider);
  const modelId = env[config.defaultModelEnvVar] ?? config.defaultModel;
  return buildCanonicalModelSelector(provider, modelId);
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
