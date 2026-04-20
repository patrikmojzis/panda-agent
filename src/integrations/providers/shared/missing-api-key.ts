import {resolveModelSelector} from "../../../kernel/agent/index.js";
import {getProviderConfig, type ProviderName} from "./provider.js";
import {resolveProviderApiKey} from "./auth.js";

/**
 * Returns the configured provider's missing-credential hint when the current
 * environment cannot satisfy that provider, otherwise `null`.
 */
export function readMissingApiKeyMessage(providerName: ProviderName): string | null {
  return resolveProviderApiKey(providerName)
    ? null
    : getProviderConfig(providerName).missingApiKeyMessage;
}

/**
 * Resolves a model selector to its provider and returns that provider's
 * missing-credential hint when needed.
 */
export function readMissingApiKeyMessageForModel(modelSelector: string): string | null {
  return readMissingApiKeyMessage(resolveModelSelector(modelSelector).providerName);
}
