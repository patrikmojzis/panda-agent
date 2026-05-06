export interface CredentialRecord {
  id: string;
  agentKey: string;
  envKey: string;
  valueCiphertext: Buffer;
  valueIv: Buffer;
  valueTag: Buffer;
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialListFilter {
  agentKey?: string;
  envKey?: string;
}

export interface CredentialResolutionContext {
  agentKey?: string;
}

export interface EncryptedCredentialValue {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export interface SetCredentialInput {
  agentKey: string;
  envKey: string;
  encryptedValue: EncryptedCredentialValue;
}

export interface DecryptedCredentialRecord {
  id: string;
  agentKey: string;
  envKey: string;
  value: string;
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialListEntry extends DecryptedCredentialRecord {
  valuePreview: string;
}

const BLOCKED_ENV_KEYS = new Set([
  "BASH_ENV",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "HOME",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "OLDPWD",
  "PATH",
  "PWD",
  "SHELL",
  "SHLVL",
]);

const RESERVED_RUNTIME_ENV_KEYS = new Set([
  "DATABASE_URL",
  "READONLY_DATABASE_URL",
  "BASH_EXECUTION_MODE",
  "RUNNER_URL_TEMPLATE",
  "RUNNER_CWD_TEMPLATE",
  "RUNNER_AGENT_KEY",
  "RUNNER_ALLOWED_ROOTS",
  "RUNNER_PORT",
  "RUNNER_HOST",
  "BROWSER_RUNNER_URL",
  "BROWSER_RUNNER_SHARED_SECRET",
  "BROWSER_RUNNER_PORT",
  "BROWSER_RUNNER_HOST",
  "BROWSER_RUNNER_DATA_DIR",
  "BROWSER_ACTION_TIMEOUT_MS",
  "BROWSER_SESSION_IDLE_TTL_MS",
  "BROWSER_SESSION_MAX_AGE_MS",
  "DEFAULT_MODEL",
  "WORKSPACE_SUBAGENT_MODEL",
  "MEMORY_SUBAGENT_MODEL",
  "BROWSER_SUBAGENT_MODEL",
  "DATA_DIR",
  "CREDENTIALS_MASTER_KEY",
  "RUNNER_IMAGE",
  "SHARED_ROOT",
]);

function requireTrimmed(field: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }

  return trimmed;
}

export function normalizeCredentialEnvKey(value: string): string {
  const normalized = requireTrimmed("Credential env key", value);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error(
      "Credential env key must use shell-safe names like OPENAI_API_KEY or notion_api_key.",
    );
  }

  const upper = normalized.toUpperCase();
  if (upper.startsWith("PANDA_") || RESERVED_RUNTIME_ENV_KEYS.has(upper)) {
    throw new Error(`Credential env key ${normalized} is reserved for runtime configuration.`);
  }
  if (BLOCKED_ENV_KEYS.has(upper)) {
    throw new Error(`Credential env key ${normalized} is not allowed.`);
  }

  return normalized;
}

export function normalizeCredentialAgentKey(value: string | undefined): string {
  return requireTrimmed("Credential agent key", value);
}

export function maskCredentialValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "(empty)";
  }

  if (trimmed.length <= 4) {
    return "*".repeat(trimmed.length);
  }

  if (trimmed.length <= 8) {
    return `${trimmed.slice(0, 1)}${"*".repeat(trimmed.length - 2)}${trimmed.slice(-1)}`;
  }

  return `${trimmed.slice(0, 4)}...${trimmed.slice(-4)}`;
}
