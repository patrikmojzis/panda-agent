import {
    buildCanonicalModelSelector,
    getProviderConfig,
    hasAnthropicOauthToken,
    hasOpenAICodexOauthToken,
    type ProviderName,
    resolveModelSelector,
} from "../kernel/agent/index.js";

function resolveDefaultPandaProvider(env: NodeJS.ProcessEnv = process.env): ProviderName {
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

export function resolveDefaultPandaModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.PANDA_MODEL?.trim();
  if (configured) {
    return resolveModelSelector(configured).canonical;
  }

  const provider = resolveDefaultPandaProvider(env);
  const config = getProviderConfig(provider);
  const modelId = env[config.defaultModelEnvVar] ?? config.defaultModel;
  return buildCanonicalModelSelector(provider, modelId);
}

export function resolveDefaultPandaExploreSubagentModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.PANDA_EXPLORE_SUBAGENT_MODEL?.trim();
  return configured ? resolveModelSelector(configured).canonical : undefined;
}

export function resolveDefaultPandaMemoryExplorerSubagentModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = env.PANDA_MEMORY_EXPLORER_SUBAGENT_MODEL?.trim();
  return configured ? resolveModelSelector(configured).canonical : undefined;
}
