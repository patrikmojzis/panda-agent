import type {JsonObject} from "../../agent-core/types.js";

export const PANDA_RUNNER_AGENT_KEY_HEADER = "x-panda-agent-key";
export const PANDA_RUNNER_PATH_SCOPED_HEADER = "x-panda-agent-path-scoped";
export const PANDA_RUNNER_EXPECTED_PATH_HEADER = "x-panda-expected-path";

export interface PersistedEnvEntry {
  key: string;
  present: boolean;
  value: string;
}

export interface BashExecutionResult {
  shell: string;
  finalCwd: string;
  durationMs: number;
  timeoutMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  abortReason: string | null;
  interrupted: boolean;
  success: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutChars: number;
  stderrChars: number;
  stdoutPersisted: boolean;
  stderrPersisted: boolean;
  noOutput: boolean;
  noOutputExpected: boolean;
  trackedEnvKeys: string[];
  persistedEnvEntries: PersistedEnvEntry[];
  stdoutPath?: string;
  stderrPath?: string;
}

export interface BashExecutorRequest {
  command: string;
  cwd: string;
  timeoutMs: number;
  trackedEnvKeys: string[];
  noOutputExpected: boolean;
  env?: Record<string, string>;
}

export interface BashRunnerExecRequest extends BashExecutorRequest {
  requestId: string;
  maxOutputChars: number;
}

export interface BashRunnerAbortRequest {
  requestId: string;
}

export interface BashRunnerAbortResponse {
  ok: boolean;
  aborted: boolean;
}

export interface BashRunnerExecResponse extends BashExecutionResult {
  ok: true;
}

export interface BashRunnerErrorResponse {
  ok: false;
  error: string;
  details?: JsonObject;
}

export type BashRunnerResponse = BashRunnerExecResponse | BashRunnerErrorResponse;
