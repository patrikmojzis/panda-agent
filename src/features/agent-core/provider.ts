import { ConfigurationError } from "./exceptions.js";

export const PROVIDER_NAMES = [
  "openai",
  "openai-codex",
  "anthropic",
  "anthropic-oauth",
] as const;

export type ProviderName = (typeof PROVIDER_NAMES)[number];

const PROVIDER_NAME_SET = new Set<string>(PROVIDER_NAMES);

function describeProviderValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatProviderNameList(): string {
  return PROVIDER_NAMES.map((provider) => `\`${provider}\``).join(", ");
}

export function isProviderName(value: unknown): value is ProviderName {
  return typeof value === "string" && PROVIDER_NAME_SET.has(value.trim());
}

export function parseProviderName(value: unknown): ProviderName | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return PROVIDER_NAME_SET.has(trimmed) ? (trimmed as ProviderName) : null;
}

export function assertProviderName(value: unknown): ProviderName {
  const providerName = parseProviderName(value);
  if (providerName) {
    return providerName;
  }

  const formattedValue =
    typeof value === "string" ? JSON.stringify(value) : describeProviderValue(value);

  throw new ConfigurationError(
    `Unsupported provider ${formattedValue}. Expected one of ${formatProviderNameList()}.`,
  );
}
