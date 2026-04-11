export interface ShellSession {
  cwd: string;
  env: Record<string, string>;
}

export interface ShellExecutionContext {
  agentKey?: string;
  shell?: ShellSession;
}
