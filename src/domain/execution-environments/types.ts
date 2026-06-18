import type {JsonValue} from "../../lib/json.js";

export const DEFAULT_EXECUTION_TARGET_ALIAS = "default";

const EXECUTION_ENVIRONMENT_ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function normalizeExecutionEnvironmentAlias(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Execution environment alias must be a string.");
  }

  const alias = value.trim().toLowerCase();
  if (!alias) {
    throw new Error("Execution environment alias must not be empty.");
  }
  if (alias === DEFAULT_EXECUTION_TARGET_ALIAS) {
    throw new Error("Execution environment alias 'default' is reserved.");
  }
  if (!EXECUTION_ENVIRONMENT_ALIAS_PATTERN.test(alias)) {
    throw new Error("Execution environment alias must use only lowercase letters, numbers, underscores, or hyphens, and start with a letter or number.");
  }

  return alias;
}

export function normalizeExecutionTargetAlias(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Execution target must be a string.");
  }

  const alias = value.trim().toLowerCase();
  if (!alias) {
    throw new Error("Execution target must not be empty.");
  }
  if (alias === DEFAULT_EXECUTION_TARGET_ALIAS) {
    return DEFAULT_EXECUTION_TARGET_ALIAS;
  }

  return normalizeExecutionEnvironmentAlias(alias);
}

export type ExecutionEnvironmentKind =
  | "persistent_agent_runner"
  | "disposable_container"
  | "local";

export type ExecutionEnvironmentState =
  | "provisioning"
  | "ready"
  | "failed"
  | "stopping"
  | "stopped";

export type ExecutionCredentialPolicy =
  | {mode: "all_agent"}
  | {mode: "none"}
  | {mode: "allowlist"; envKeys: readonly string[]};

export type ExecutionSkillPolicy =
  | {mode: "all_agent"}
  | {mode: "none"}
  | {mode: "allowlist"; skillKeys: readonly string[]};

export type AgentSkillOperation = "load" | "set" | "delete";

export interface ExecutionAgentSkillToolPolicy {
  allowedOperations?: readonly AgentSkillOperation[];
}

export interface ExecutionToolPolicy {
  allowedTools?: readonly string[];
  bash?: {
    allowed?: boolean;
  };
  postgresReadonly?: {
    allowed?: boolean;
  };
  agentSkill?: ExecutionAgentSkillToolPolicy;
}

export interface ExecutionEnvironmentRecord {
  id: string;
  agentKey: string;
  kind: ExecutionEnvironmentKind;
  state: ExecutionEnvironmentState;
  runnerUrl?: string;
  runnerCwd?: string;
  rootPath?: string;
  createdBySessionId?: string;
  createdForSessionId?: string;
  expiresAt?: number;
  metadata?: JsonValue;
  createdAt: number;
  updatedAt: number;
}

export interface SessionEnvironmentBindingRecord {
  sessionId: string;
  environmentId: string;
  alias: string;
  isDefault: boolean;
  credentialPolicy: ExecutionCredentialPolicy;
  skillPolicy: ExecutionSkillPolicy;
  toolPolicy: ExecutionToolPolicy;
  createdAt: number;
  updatedAt: number;
}

export interface CreateExecutionEnvironmentInput {
  id: string;
  agentKey: string;
  kind: ExecutionEnvironmentKind;
  state?: ExecutionEnvironmentState;
  runnerUrl?: string;
  runnerCwd?: string;
  rootPath?: string;
  createdBySessionId?: string;
  createdForSessionId?: string;
  expiresAt?: number;
  metadata?: JsonValue;
}

export interface BindSessionEnvironmentInput {
  sessionId: string;
  environmentId: string;
  alias: string;
  isDefault?: boolean;
  credentialPolicy?: ExecutionCredentialPolicy;
  skillPolicy?: ExecutionSkillPolicy;
  toolPolicy?: ExecutionToolPolicy;
}

export interface ListDisposableEnvironmentsByOwnerInput {
  agentKey: string;
  createdBySessionId: string;
}

export interface ResolvedExecutionEnvironment {
  id: string;
  agentKey: string;
  kind: ExecutionEnvironmentKind;
  state: ExecutionEnvironmentState;
  executionMode: "local" | "remote";
  runnerUrl?: string;
  initialCwd?: string;
  rootPath?: string;
  metadata?: JsonValue;
  alias?: string;
  credentialPolicy: ExecutionCredentialPolicy;
  skillPolicy: ExecutionSkillPolicy;
  toolPolicy: ExecutionToolPolicy;
  source: "binding" | "fallback";
}

export interface DisposableEnvironmentCreateRequest {
  agentKey: string;
  sessionId: string;
  environmentId: string;
  ttlMs?: number;
  metadata?: JsonValue;
}

export interface DisposableEnvironmentCreateResult {
  runnerUrl: string;
  runnerCwd: string;
  rootPath?: string;
  metadata?: JsonValue;
}

export interface ExecutionEnvironmentManager {
  createDisposableEnvironment(input: DisposableEnvironmentCreateRequest): Promise<DisposableEnvironmentCreateResult>;
  stopEnvironment(environmentId: string): Promise<void>;
}
