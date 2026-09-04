import type {
    BindSessionEnvironmentInput,
    CreateExecutionEnvironmentInput,
    ClaimExecutionEnvironmentOperationInput,
    SettleExecutionEnvironmentOperationInput,
    ExecutionEnvironmentRecord,
    ListDisposableEnvironmentsByOwnerInput,
    SessionEnvironmentBindingRecord,
} from "./types.js";

export interface ExecutionEnvironmentStore {
  createEnvironment(input: CreateExecutionEnvironmentInput): Promise<ExecutionEnvironmentRecord>;
  reserveEnvironment(input: CreateExecutionEnvironmentInput & {operationId: string}): Promise<ExecutionEnvironmentRecord | null>;
  claimEnvironmentOperation(input: ClaimExecutionEnvironmentOperationInput): Promise<ExecutionEnvironmentRecord | null>;
  settleEnvironmentOperation(input: SettleExecutionEnvironmentOperationInput): Promise<ExecutionEnvironmentRecord | null>;
  bindSession(input: BindSessionEnvironmentInput): Promise<SessionEnvironmentBindingRecord>;
  getEnvironment(environmentId: string): Promise<ExecutionEnvironmentRecord>;
  getBinding(sessionId: string, environmentId: string): Promise<SessionEnvironmentBindingRecord | null>;
  getDefaultBinding(sessionId: string): Promise<SessionEnvironmentBindingRecord | null>;
  getBindingByAlias(sessionId: string, alias: string): Promise<SessionEnvironmentBindingRecord | null>;
  deleteBindingByAlias(sessionId: string, alias: string): Promise<boolean>;
  listBindingsForSession(sessionId: string): Promise<readonly SessionEnvironmentBindingRecord[]>;
  listDisposableEnvironmentsByOwner(input: ListDisposableEnvironmentsByOwnerInput): Promise<readonly ExecutionEnvironmentRecord[]>;
  listBindingsForEnvironments(environmentIds: readonly string[]): Promise<readonly SessionEnvironmentBindingRecord[]>;
  listExpiredDisposableEnvironments(now: number, limit: number): Promise<readonly ExecutionEnvironmentRecord[]>;
}
