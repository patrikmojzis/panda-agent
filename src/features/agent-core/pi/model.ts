import { getModel, type Api, type Model } from "@mariozechner/pi-ai";

import { assertProviderName, type ProviderName } from "../provider.js";

const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const ANTHROPIC_BASE_URL = "https://api.anthropic.com";

function resolvePiProviderName(providerName: ProviderName): "openai" | "openai-codex" | "anthropic" {
  if (providerName === "openai-codex") {
    return "openai-codex";
  }

  if (providerName === "anthropic" || providerName === "anthropic-oauth") {
    return "anthropic";
  }

  return "openai";
}

function buildFallbackModel(providerName: ProviderName, modelId: string): Model<Api> {
  if (providerName === "openai-codex") {
    return {
      id: modelId,
      name: modelId,
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: OPENAI_CODEX_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400000,
      maxTokens: 128000,
    };
  }

  if (providerName === "anthropic" || providerName === "anthropic-oauth") {
    return {
      id: modelId,
      name: modelId,
      api: "anthropic-messages",
      provider: "anthropic",
      baseUrl: ANTHROPIC_BASE_URL,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 8192,
    };
  }

  return {
    id: modelId,
    name: modelId,
    api: "openai-responses",
    provider: "openai",
    baseUrl: OPENAI_BASE_URL,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400000,
    maxTokens: 128000,
  };
}

export function resolvePandaModel(providerName: ProviderName, modelId: string): Model<Api> {
  const resolvedProviderName = assertProviderName(providerName);
  const runtimeProvider = resolvePiProviderName(resolvedProviderName);

  try {
    return getModel(runtimeProvider, modelId as never) as Model<Api>;
  } catch {
    return buildFallbackModel(resolvedProviderName, modelId);
  }
}
