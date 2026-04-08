export interface PandaShellSession {
  cwd: string;
  env: Record<string, string>;
}

export interface PandaSessionContext {
  cwd?: string;
  shell?: PandaShellSession;
  locale?: string;
  timezone?: string;
  threadId?: string;
  agentKey?: string;
}
