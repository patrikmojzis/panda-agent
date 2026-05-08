import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/index.js";

export interface ShellSession {
  cwd: string;
  env: Record<string, string>;
  secretEnvKeys?: string[];
}

export interface ShellExecutionContext {
  agentKey?: string;
  /** Legacy persisted shell state; new state lives in shellSessions. */
  shell?: ShellSession;
  shellSessions?: Record<string, ShellSession>;
  executionEnvironment?: ResolvedExecutionEnvironment;
}
