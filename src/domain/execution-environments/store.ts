import type {
    BindSessionEnvironmentInput,
    CreateExecutionEnvironmentInput,
    ExecutionEnvironmentRecord,
    ListDisposableEnvironmentsByOwnerInput,
    SessionEnvironmentBindingRecord,
} from "./types.js";

export interface ExecutionEnvironmentStore {
  ensureSchema(): Promise<void>;
  createEnvironment(input: CreateExecutionEnvironmentInput): Promise<ExecutionEnvironmentRecord>;
  bindSession(input: BindSessionEnvironmentInput): Promise<SessionEnvironmentBindingRecord>;
  getEnvironment(environmentId: string): Promise<ExecutionEnvironmentRecord>;
  getDefaultBinding(sessionId: string): Promise<SessionEnvironmentBindingRecord | null>;
  listDisposableEnvironmentsByOwner(input: ListDisposableEnvironmentsByOwnerInput): Promise<readonly ExecutionEnvironmentRecord[]>;
  listBindingsForEnvironments(environmentIds: readonly string[]): Promise<readonly SessionEnvironmentBindingRecord[]>;
  listExpiredDisposableEnvironments(now: number, limit: number): Promise<readonly ExecutionEnvironmentRecord[]>;
}
