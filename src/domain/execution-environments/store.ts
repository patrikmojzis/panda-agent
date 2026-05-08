import type {
    BindSessionEnvironmentInput,
    CreateExecutionEnvironmentInput,
    ExecutionEnvironmentRecord,
    SessionEnvironmentBindingRecord,
} from "./types.js";

export interface ExecutionEnvironmentStore {
  ensureSchema(): Promise<void>;
  createEnvironment(input: CreateExecutionEnvironmentInput): Promise<ExecutionEnvironmentRecord>;
  bindSession(input: BindSessionEnvironmentInput): Promise<SessionEnvironmentBindingRecord>;
  getEnvironment(environmentId: string): Promise<ExecutionEnvironmentRecord>;
  getDefaultBinding(sessionId: string): Promise<SessionEnvironmentBindingRecord | null>;
  listExpiredDisposableEnvironments(now: number, limit: number): Promise<readonly ExecutionEnvironmentRecord[]>;
}
