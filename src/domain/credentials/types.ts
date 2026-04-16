export const CREDENTIAL_SCOPES = ["relationship", "agent", "identity"] as const;

export type CredentialScope = typeof CREDENTIAL_SCOPES[number];

export interface CredentialScopeInput {
  scope: CredentialScope;
  agentKey?: string;
  identityId?: string;
}

export interface CredentialRecord extends CredentialScopeInput {
  id: string;
  envKey: string;
  valueCiphertext: Buffer;
  valueIv: Buffer;
  valueTag: Buffer;
  keyVersion: number;
  createdAt: number;
  updatedAt: number;
}

export interface CredentialListFilter extends Partial<CredentialScopeInput> {
  envKey?: string;
}

export interface CredentialResolutionContext {
  agentKey?: string;
  identityId?: string;
}

export interface EncryptedCredentialValue {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
}

export interface SetCredentialInput extends CredentialScopeInput {
  envKey: string;
  encryptedValue: EncryptedCredentialValue;
}

export interface DecryptedCredentialRecord extends CredentialScopeInput {
  id: string;
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

export function normalizeCredentialScopeInput<T extends CredentialScopeInput>(input: T): T {
  const scope = input.scope;
  const agentKey = input.agentKey?.trim() || undefined;
  const identityId = input.identityId?.trim() || undefined;

  if (scope === "relationship") {
    return {
      ...input,
      scope,
      agentKey: requireTrimmed("Relationship credential agent key", agentKey),
      identityId: requireTrimmed("Relationship credential identity id", identityId),
    };
  }

  if (scope === "agent") {
    if (identityId) {
      throw new Error("Agent credentials do not take identityId.");
    }

    return {
      ...input,
      scope,
      agentKey: requireTrimmed("Agent credential agent key", agentKey),
      identityId: undefined,
    };
  }

  if (agentKey) {
    throw new Error("Identity credentials do not take agentKey.");
  }

  return {
    ...input,
    scope,
    agentKey: undefined,
    identityId: requireTrimmed("Identity credential identity id", identityId),
  };
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
