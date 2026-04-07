import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assertProviderName, type ProviderName } from "../provider.js";

function trimNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

const OPENAI_CODEX_OAUTH_ENV_VARS = ["OPENAI_OAUTH_TOKEN"] as const;
const ANTHROPIC_OAUTH_ENV_VARS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = trimNonEmptyString(env.CODEX_HOME);
  if (!configured) {
    return path.join(os.homedir(), ".codex");
  }

  if (configured === "~") {
    return os.homedir();
  }

  if (configured.startsWith("~/")) {
    return path.join(os.homedir(), configured.slice(2));
  }

  return path.resolve(configured);
}

export function resolveOpenAICodexAuthFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveCodexHome(env), "auth.json");
}

type OpenAICodexAuthFile = {
  auth_mode?: unknown;
  tokens?: {
    access_token?: unknown;
  };
};

function readOpenAICodexAuthFile(authFilePath: string): OpenAICodexAuthFile | null {
  try {
    const raw = fs.readFileSync(authFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as OpenAICodexAuthFile) : null;
  } catch {
    return null;
  }
}

export function resolveOpenAICodexOauthToken(options: {
  env?: NodeJS.ProcessEnv;
  authFilePath?: string;
} = {}): string | null {
  const env = options.env ?? process.env;

  for (const key of OPENAI_CODEX_OAUTH_ENV_VARS) {
    const value = trimNonEmptyString(env[key]);
    if (value) {
      return value;
    }
  }

  const authFile = readOpenAICodexAuthFile(options.authFilePath ?? resolveOpenAICodexAuthFilePath(env));
  if (!authFile || authFile.auth_mode !== "chatgpt") {
    return null;
  }

  return trimNonEmptyString(authFile.tokens?.access_token) ?? null;
}

export function hasOpenAICodexOauthToken(options: {
  env?: NodeJS.ProcessEnv;
  authFilePath?: string;
} = {}): boolean {
  return resolveOpenAICodexOauthToken(options) !== null;
}

export function resolveAnthropicAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ANTHROPIC_OAUTH_ENV_VARS) {
    const value = trimNonEmptyString(env[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

export function hasAnthropicOauthToken(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAnthropicAccessToken(env) !== null;
}

export function resolveProviderApiKey(
  providerName: ProviderName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const resolvedProviderName = assertProviderName(providerName);

  if (resolvedProviderName === "openai-codex") {
    return resolveOpenAICodexOauthToken({ env }) ?? undefined;
  }

  if (resolvedProviderName === "anthropic-oauth") {
    return resolveAnthropicAccessToken(env) ?? undefined;
  }

  if (resolvedProviderName === "anthropic") {
    return (
      resolveAnthropicAccessToken(env) ??
      trimNonEmptyString(env.ANTHROPIC_API_KEY)
    );
  }

  if (resolvedProviderName === "openai") {
    return trimNonEmptyString(env.OPENAI_API_KEY);
  }

  return undefined;
}
