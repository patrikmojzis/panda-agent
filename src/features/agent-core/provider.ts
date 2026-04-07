import { ConfigurationError } from "./exceptions.js";

type RuntimeProviderName = "openai" | "openai-codex" | "anthropic";
export type ProviderAuthKind =
  | "openai-api-key"
  | "openai-codex-oauth"
  | "anthropic-api-key-or-oauth"
  | "anthropic-oauth";

export interface ProviderConfig {
  runtimeProvider: RuntimeProviderName;
  authKind: ProviderAuthKind;
  defaultModelEnvVar: string;
  defaultModel: string;
  missingApiKeyMessage: string;
}

export const PROVIDER_CONFIGS = {
  openai: {
    runtimeProvider: "openai",
    authKind: "openai-api-key",
    defaultModelEnvVar: "OPENAI_MODEL",
    defaultModel: "gpt-5.1",
    missingApiKeyMessage: "Missing OPENAI_API_KEY.",
  },
  "openai-codex": {
    runtimeProvider: "openai-codex",
    authKind: "openai-codex-oauth",
    defaultModelEnvVar: "OPENAI_CODEX_MODEL",
    defaultModel: "gpt-5.4",
    missingApiKeyMessage: "Missing OpenAI Codex OAuth token. Run `codex login` or set OPENAI_OAUTH_TOKEN.",
  },
  anthropic: {
    runtimeProvider: "anthropic",
    authKind: "anthropic-api-key-or-oauth",
    defaultModelEnvVar: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-4-5",
    missingApiKeyMessage:
      "Missing ANTHROPIC_API_KEY. You can also provide ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN.",
  },
  "anthropic-oauth": {
    runtimeProvider: "anthropic",
    authKind: "anthropic-oauth",
    defaultModelEnvVar: "ANTHROPIC_MODEL",
    defaultModel: "claude-sonnet-4-5",
    missingApiKeyMessage:
      "Missing Anthropic OAuth token. Add ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN, or CLAUDE_CODE_OAUTH_TOKEN.",
  },
} as const satisfies Record<string, ProviderConfig>;

export type ProviderName = keyof typeof PROVIDER_CONFIGS;
export const PROVIDER_NAMES = Object.keys(PROVIDER_CONFIGS) as ProviderName[];

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

export function getProviderConfig(providerName: ProviderName): ProviderConfig {
  return PROVIDER_CONFIGS[assertProviderName(providerName)];
}
