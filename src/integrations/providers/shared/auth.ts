import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {trimToUndefined} from "../../../lib/strings.js";
import {getProviderConfig, type ProviderAuthKind, type ProviderName} from "./provider.js";

const OPENAI_CODEX_OAUTH_ENV_VARS = ["OPENAI_OAUTH_TOKEN"] as const;
const ANTHROPIC_OAUTH_ENV_VARS = [
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = trimToUndefined(env.CODEX_HOME);
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
    const value = trimToUndefined(env[key]);
    if (value) {
      return value;
    }
  }

  const authFile = readOpenAICodexAuthFile(options.authFilePath ?? resolveOpenAICodexAuthFilePath(env));
  if (!authFile || authFile.auth_mode !== "chatgpt") {
    return null;
  }

  return trimToUndefined(authFile.tokens?.access_token) ?? null;
}

export function hasOpenAICodexOauthToken(options: {
  env?: NodeJS.ProcessEnv;
  authFilePath?: string;
} = {}): boolean {
  return resolveOpenAICodexOauthToken(options) !== null;
}

export function resolveAnthropicAccessToken(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const key of ANTHROPIC_OAUTH_ENV_VARS) {
    const value = trimToUndefined(env[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

export function hasAnthropicOauthToken(env: NodeJS.ProcessEnv = process.env): boolean {
  return resolveAnthropicAccessToken(env) !== null;
}

const AUTH_RESOLVERS: Record<ProviderAuthKind, (env: NodeJS.ProcessEnv) => string | undefined> = {
  "openai-api-key": (env) => trimToUndefined(env.OPENAI_API_KEY),
  "openai-codex-oauth": (env) => resolveOpenAICodexOauthToken({env}) ?? undefined,
  "anthropic-api-key-or-oauth": (env) => {
    return (
      resolveAnthropicAccessToken(env) ??
      trimToUndefined(env.ANTHROPIC_API_KEY)
    );
  },
  "anthropic-oauth": (env) => resolveAnthropicAccessToken(env) ?? undefined,
};

export function resolveProviderApiKey(
  providerName: ProviderName,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const config = getProviderConfig(providerName);
  return AUTH_RESOLVERS[config.authKind](env);
}
