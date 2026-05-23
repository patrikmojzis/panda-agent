import type {ReplaceSessionTodoInput, SessionTodoRecord} from "./todos.js";
import type {
  ClaimSessionHeartbeatInput,
  CreateSessionInput,
  DeleteSessionPromptInput,
  ListDueSessionHeartbeatsInput,
  RecordSessionHeartbeatResultInput,
  ResolveSessionRefInput,
  SessionHeartbeatRecord,
  SessionPromptRecord,
  SessionPromptSlug,
  SessionRecord,
  SetSessionPromptInput,
  UpdateSessionCurrentThreadInput,
  UpdateSessionHeartbeatConfigInput,
  UpdateSessionLabelInput,
} from "./types.js";

export interface SessionStore {
  ensureSchema(): Promise<void>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord>;
  getSessionByAlias(agentKey: string, alias: string): Promise<SessionRecord | null>;
  resolveSessionRef(input: ResolveSessionRefInput): Promise<SessionRecord>;
  getMainSession(agentKey: string): Promise<SessionRecord | null>;
  listAgentSessions(agentKey: string): Promise<readonly SessionRecord[]>;
  updateSessionLabel(input: UpdateSessionLabelInput): Promise<SessionRecord>;
  updateCurrentThread(input: UpdateSessionCurrentThreadInput): Promise<SessionRecord>;
  readSessionPrompt(sessionId: string, slug?: SessionPromptSlug): Promise<SessionPromptRecord | null>;
  listSessionPrompts(sessionId: string): Promise<readonly SessionPromptRecord[]>;
  setSessionPrompt(input: SetSessionPromptInput): Promise<SessionPromptRecord>;
  deleteSessionPrompt(input: DeleteSessionPromptInput): Promise<boolean>;
  readSessionTodo(sessionId: string): Promise<SessionTodoRecord | null>;
  replaceSessionTodo(input: ReplaceSessionTodoInput): Promise<SessionTodoRecord | null>;
  getHeartbeat(sessionId: string): Promise<SessionHeartbeatRecord | null>;
  listDueHeartbeats(input?: ListDueSessionHeartbeatsInput): Promise<readonly SessionHeartbeatRecord[]>;
  claimHeartbeat(input: ClaimSessionHeartbeatInput): Promise<SessionHeartbeatRecord | null>;
  recordHeartbeatResult(input: RecordSessionHeartbeatResultInput): Promise<SessionHeartbeatRecord>;
  updateHeartbeatConfig(input: UpdateSessionHeartbeatConfigInput): Promise<SessionHeartbeatRecord>;
}
