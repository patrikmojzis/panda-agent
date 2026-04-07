import { getModel, type Api, type Model } from "@mariozechner/pi-ai";

import { getProviderConfig, type ProviderName } from "../provider.js";

function buildFallbackModel(providerName: ProviderName, modelId: string): Model<Api> {
  const { fallbackModel } = getProviderConfig(providerName);
  return {
    id: modelId,
    name: modelId,
    api: fallbackModel.api,
    provider: fallbackModel.provider,
    baseUrl: fallbackModel.baseUrl,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: fallbackModel.contextWindow,
    maxTokens: fallbackModel.maxTokens,
  };
}

export function resolvePandaModel(providerName: ProviderName, modelId: string): Model<Api> {
  const config = getProviderConfig(providerName);

  try {
    return getModel(config.runtimeProvider, modelId as never) as Model<Api>;
  } catch {
    return buildFallbackModel(providerName, modelId);
  }
}
