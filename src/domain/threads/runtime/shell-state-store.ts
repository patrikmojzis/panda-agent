export interface ThreadShellStateKey {
  sessionId: string;
  threadId: string;
  executionEnvironmentId: string;
}

export interface DurableShellSession {
  cwd: string;
  env: Record<string, string>;
}

export interface ThreadShellStateRecord extends ThreadShellStateKey {
  shellSession: DurableShellSession;
  updatedAt: number;
}

export interface ThreadShellStateStore {
  listShellSessions(input: Pick<ThreadShellStateKey, "sessionId" | "threadId">): Promise<Record<string, DurableShellSession>>;
  upsertShellSession(input: ThreadShellStateKey & {shellSession: DurableShellSession}): Promise<ThreadShellStateRecord>;
}
