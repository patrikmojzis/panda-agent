const BLOCKED_REMOTE_ENV_KEYS = new Set([
  "PANDA_DATABASE_URL",
  "DATABASE_URL",
  "PANDA_READONLY_DATABASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "BRAVE_API_KEY",
  "TELEGRAM_BOT_TOKEN",
]);

export function isBlockedRemoteEnvKey(key: string): boolean {
  return BLOCKED_REMOTE_ENV_KEYS.has(key.trim());
}

export function listBlockedRemoteEnvKeys(env: Record<string, string> | undefined): string[] {
  if (!env) {
    return [];
  }

  return Object.keys(env)
    .filter((key) => isBlockedRemoteEnvKey(key))
    .sort();
}

export function filterRemoteShellEnv(
  env: NodeJS.ProcessEnv | Record<string, string> | undefined,
): Record<string, string> {
  if (!env) {
    return {};
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || isBlockedRemoteEnvKey(key)) {
      continue;
    }

    filtered[key] = value;
  }

  return filtered;
}
