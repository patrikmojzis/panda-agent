import {getModels} from "@earendil-works/pi-ai/compat";
import type {Api, Model} from "@earendil-works/pi-ai";

import {ConfigurationError} from "../../../kernel/agent/exceptions.js";
import {getProviderConfig, type ProviderName} from "./provider.js";

export function resolveProviderModel(providerName: ProviderName, modelId: string): Model<Api> {
  const config = getProviderConfig(providerName);

  const model = getModels(config.runtimeProvider).find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new ConfigurationError(
      `Unknown model ${JSON.stringify(modelId)} for provider ${JSON.stringify(providerName)}.`,
    );
  }

  return model;
}
