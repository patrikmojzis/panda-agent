import type {ShellSession} from "../../../integrations/shell/types.js";

export interface ThreadShellStateKey {
  sessionId: string;
  threadId: string;
  executionEnvironmentId: string;
}

export interface ThreadShellStateRecord extends ThreadShellStateKey {
  shellSession: ShellSession;
  updatedAt: number;
}

export interface ThreadShellStateStore {
  listShellSessions(input: Pick<ThreadShellStateKey, "sessionId" | "threadId">): Promise<Record<string, ShellSession>>;
  upsertShellSession(input: ThreadShellStateKey & {shellSession: ShellSession}): Promise<ThreadShellStateRecord>;
}
