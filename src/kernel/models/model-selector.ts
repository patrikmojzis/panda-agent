import {ConfigurationError} from "../agent/exceptions.js";
import {assertProviderName, type ProviderName} from "../../integrations/providers/shared/provider.js";

const MODEL_SELECTOR_ALIASES = {
  gpt: "openai-codex/gpt-5.4",
  opus: "anthropic-oauth/claude-opus-4-6",
} as const satisfies Record<string, string>;

export interface ResolvedModelSelector {
  canonical: string;
  providerName: ProviderName;
  modelId: string;
}

function formatAliasList(): string {
  return Object.keys(MODEL_SELECTOR_ALIASES).map((alias) => `\`${alias}\``).join(", ");
}

function trimSelectorValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConfigurationError(`Model selector must be a string, got ${JSON.stringify(value)}.`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConfigurationError("Model selector must not be empty.");
  }

  return trimmed;
}

export function buildCanonicalModelSelector(providerName: ProviderName, modelId: string): string {
  const trimmedModelId = trimSelectorValue(modelId);
  return `${providerName}/${trimmedModelId}`;
}

export function resolveModelSelector(value: string): ResolvedModelSelector {
  const trimmed = trimSelectorValue(value);

  if (!trimmed.includes("/")) {
    const canonical = MODEL_SELECTOR_ALIASES[trimmed as keyof typeof MODEL_SELECTOR_ALIASES];
    if (!canonical) {
      throw new ConfigurationError(
        `Unknown model alias ${JSON.stringify(trimmed)}. Use a canonical selector like \`provider/model\` or one of ${formatAliasList()}.`,
      );
    }

    return resolveModelSelector(canonical);
  }

  const separatorIndex = trimmed.indexOf("/");
  const providerName = assertProviderName(trimmed.slice(0, separatorIndex));
  const modelId = trimmed.slice(separatorIndex + 1).trim();

  if (!modelId) {
    throw new ConfigurationError(`Model selector ${JSON.stringify(trimmed)} is missing a model id.`);
  }

  return {
    canonical: buildCanonicalModelSelector(providerName, modelId),
    providerName,
    modelId,
  };
}
