import {
  assertProviderName,
  getProviderConfig,
  hasAnthropicOauthToken,
  hasOpenAICodexOauthToken,
  type ProviderName,
} from "../agent-core/index.js";

export function resolveDefaultPandaProvider(env: NodeJS.ProcessEnv = process.env): ProviderName {
  const configured = env.PANDA_PROVIDER;

  if (configured) {
    return assertProviderName(configured);
  }

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

export function resolveDefaultPandaModel(
  provider: ProviderName,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.PANDA_MODEL) {
    return env.PANDA_MODEL;
  }

  const config = getProviderConfig(provider);
  return env[config.defaultModelEnvVar] ?? config.defaultModel;
}
