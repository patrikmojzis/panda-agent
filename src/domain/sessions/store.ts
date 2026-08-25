import type {ReplaceSessionTodoInput, SessionTodoRecord} from "./todos.js";
import type {
  ClaimSessionHeartbeatInput,
  CreateSessionInput,
  DeleteSessionPromptInput,
  ListDueSessionHeartbeatsInput,
  ListAgentSessionsInput,
  RecordSessionHeartbeatResultInput,
  ResolveSessionRefInput,
  SessionHeartbeatRecord,
  SessionPromptRecord,
  SessionPromptSlug,
  SessionRecord,
  SetSessionPromptInput,
  SessionRuntimeConfigRecord,
  SessionRuntimeConfigOperationRecord,
  SessionCreationOperationRecord,
  UpdateSessionCurrentThreadInput,
  UpdateSessionHeartbeatConfigInput,
  UpdateSessionLabelInput,
  UpdateSessionRuntimeConfigInput,
  TransformSessionPromptInput,
  TransformSessionPromptResult,
} from "./types.js";

export interface SessionStore {
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord>;
  getSessionByAlias(agentKey: string, alias: string): Promise<SessionRecord | null>;
  resolveSessionRef(input: ResolveSessionRefInput): Promise<SessionRecord>;
  getMainSession(agentKey: string): Promise<SessionRecord | null>;
  listAgentSessions(agentKey: string, input?: ListAgentSessionsInput): Promise<readonly SessionRecord[]>;
  updateSessionLabel(input: UpdateSessionLabelInput): Promise<SessionRecord>;
  updateCurrentThread(input: UpdateSessionCurrentThreadInput): Promise<SessionRecord>;
  getSessionRuntimeConfig(sessionId: string): Promise<SessionRuntimeConfigRecord>;
  updateSessionRuntimeConfig(input: UpdateSessionRuntimeConfigInput): Promise<SessionRuntimeConfigRecord>;
  updateSessionRuntimeConfigOnce(
    operationId: string,
    threadId: string,
    input: UpdateSessionRuntimeConfigInput,
  ): Promise<{config: SessionRuntimeConfigRecord; replayed: boolean}>;
  getSessionRuntimeConfigOperation(operationId: string): Promise<SessionRuntimeConfigOperationRecord | null>;
  getSessionCreationOperation(operationId: string): Promise<SessionCreationOperationRecord | null>;
  recordSessionCreationOperation(input: Omit<SessionCreationOperationRecord, "createdAt">): Promise<SessionCreationOperationRecord>;
  recordMainSessionResolutionOperation(input: {
    operationId: string;
    identityId: string;
    agentKey: string;
    sessionId: string;
  }): Promise<SessionCreationOperationRecord>;
  /** Compensates a subagent create saga only while it still owns the initial thread. */
  deleteSubagentCreation(sessionId: string, threadId: string): Promise<boolean>;
  readSessionPrompt(sessionId: string, slug?: SessionPromptSlug): Promise<SessionPromptRecord | null>;
  listSessionPrompts(sessionId: string): Promise<readonly SessionPromptRecord[]>;
  setSessionPrompt(input: SetSessionPromptInput): Promise<SessionPromptRecord>;
  transformSessionPrompt(input: TransformSessionPromptInput): Promise<TransformSessionPromptResult>;
  deleteSessionPrompt(input: DeleteSessionPromptInput): Promise<boolean>;
  readSessionTodo(sessionId: string): Promise<SessionTodoRecord | null>;
  replaceSessionTodo(input: ReplaceSessionTodoInput): Promise<SessionTodoRecord | null>;
  getHeartbeat(sessionId: string): Promise<SessionHeartbeatRecord | null>;
  listDueHeartbeats(input?: ListDueSessionHeartbeatsInput): Promise<readonly SessionHeartbeatRecord[]>;
  claimHeartbeat(input: ClaimSessionHeartbeatInput): Promise<SessionHeartbeatRecord | null>;
  recordHeartbeatResult(input: RecordSessionHeartbeatResultInput): Promise<SessionHeartbeatRecord>;
  updateHeartbeatConfig(input: UpdateSessionHeartbeatConfigInput): Promise<SessionHeartbeatRecord>;
}
