import {hasAnthropicOauthToken, hasOpenAICodexOauthToken,} from "../../integrations/providers/shared/auth.js";
import {getProviderConfig, type ProviderName} from "../../integrations/providers/shared/provider.js";
import {buildCanonicalModelSelector, resolveModelSelector} from "./model-selector.js";

function resolveDefaultModelProvider(env: NodeJS.ProcessEnv = process.env): ProviderName {
  if (hasAnthropicOauthToken(env) && !env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    return "anthropic-oauth";
  }

  if (hasOpenAICodexOauthToken({env}) && !env.OPENAI_API_KEY) {
    return "openai-codex";
  }

  if (env.ANTHROPIC_API_KEY && !env.OPENAI_API_KEY) {
    return "anthropic";
  }

  return "openai";
}

export function resolveRuntimeDefaultModelSelector(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.DEFAULT_MODEL?.trim();
  if (configured) {
    return resolveModelSelector(configured).canonical;
  }

  const provider = resolveDefaultModelProvider(env);
  const config = getProviderConfig(provider);
  const modelId = env[config.defaultModelEnvVar] ?? config.defaultModel;
  return buildCanonicalModelSelector(provider, modelId);
}
