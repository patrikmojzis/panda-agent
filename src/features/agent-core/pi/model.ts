import { getModel, type Api, type Model } from "@mariozechner/pi-ai";

import { ConfigurationError } from "../exceptions.js";
import { getProviderConfig, type ProviderName } from "../provider.js";

export function resolvePandaModel(providerName: ProviderName, modelId: string): Model<Api> {
  const config = getProviderConfig(providerName);

  const model = getModel(config.runtimeProvider, modelId as never) as Model<Api> | undefined;
  if (!model) {
    throw new ConfigurationError(
      `Unknown model ${JSON.stringify(modelId)} for provider ${JSON.stringify(providerName)}.`,
    );
  }

  return model;
}
