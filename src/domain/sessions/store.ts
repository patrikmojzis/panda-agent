import type {
    ClaimSessionHeartbeatInput,
    CreateSessionInput,
    ListDueSessionHeartbeatsInput,
    RecordSessionHeartbeatResultInput,
    SessionHeartbeatRecord,
    SessionRecord,
    UpdateSessionCurrentThreadInput,
    UpdateSessionHeartbeatConfigInput,
} from "./types.js";

export interface SessionStore {
  ensureSchema(): Promise<void>;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  getSession(sessionId: string): Promise<SessionRecord>;
  getMainSession(agentKey: string): Promise<SessionRecord | null>;
  listAgentSessions(agentKey: string): Promise<readonly SessionRecord[]>;
  updateCurrentThread(input: UpdateSessionCurrentThreadInput): Promise<SessionRecord>;
  getHeartbeat(sessionId: string): Promise<SessionHeartbeatRecord | null>;
  listDueHeartbeats(input?: ListDueSessionHeartbeatsInput): Promise<readonly SessionHeartbeatRecord[]>;
  claimHeartbeat(input: ClaimSessionHeartbeatInput): Promise<SessionHeartbeatRecord | null>;
  recordHeartbeatResult(input: RecordSessionHeartbeatResultInput): Promise<SessionHeartbeatRecord>;
  updateHeartbeatConfig(input: UpdateSessionHeartbeatConfigInput): Promise<SessionHeartbeatRecord>;
}
