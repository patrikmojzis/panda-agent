import {getModels} from "@earendil-works/pi-ai/compat";
import type {Api, Model} from "@earendil-works/pi-ai";

import {ConfigurationError} from "../../../kernel/agent/exceptions.js";
import {getProviderConfig, type ProviderName} from "./provider.js";

export function resolveProviderModel(providerName: ProviderName, modelId: string): Model<Api> {
  const config = getProviderConfig(providerName);

  const model = getModels(config.runtimeProvider).find((candidate) => candidate.id === modelId);
  if (model) {
    return model;
  }

  // Temporary catalog entry until pi-ai ships Astra. Prefer upstream metadata above.
  // API limits/pricing: https://developers.openai.com/api/docs/models/gpt-6-astra
  // Codex uses the conservative 272k default advertised by its model catalog.
  if (modelId === "gpt-6-astra" && (providerName === "openai" || providerName === "openai-codex")) {
    const codex = providerName === "openai-codex";
    return {
      id: modelId,
      name: "GPT-6 Astra",
      provider: providerName,
      api: codex ? "openai-codex-responses" : "openai-responses",
      baseUrl: codex ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1",
      reasoning: true,
      thinkingLevelMap: {off: null, minimal: null, xhigh: "xhigh", max: "max"},
      input: ["text", "image"],
      contextWindow: codex ? 272_000 : 1_050_000,
      maxTokens: 128_000,
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [{inputTokensAbove: 272_000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25}],
      },
    };
  }

  throw new ConfigurationError(
    `Unknown model ${JSON.stringify(modelId)} for provider ${JSON.stringify(providerName)}.`,
  );
}
