import type {JsonValue} from "../../kernel/agent/types.js";

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

export interface ExecutionToolPolicy {
  bash?: {
    allowed?: boolean;
  };
  postgresReadonly?: {
    allowed?: boolean;
  };
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
