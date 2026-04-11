export interface ShellSession {
  cwd: string;
  env: Record<string, string>;
  secretEnvKeys?: string[];
}

export interface ShellExecutionContext {
  agentKey?: string;
  shell?: ShellSession;
}
