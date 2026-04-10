import {
    buildCanonicalModelSelector,
    getProviderConfig,
    hasAnthropicOauthToken,
    hasOpenAICodexOauthToken,
    type ProviderName,
    resolveModelSelector,
} from "../agent-core/index.js";

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
