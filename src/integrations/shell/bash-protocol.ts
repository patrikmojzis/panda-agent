import type {JsonObject} from "../../kernel/agent/types.js";

export const RUNNER_AGENT_KEY_HEADER = "x-runtime-agent-key";
export const RUNNER_PATH_SCOPED_HEADER = "x-runtime-agent-path-scoped";
export const RUNNER_EXPECTED_PATH_HEADER = "x-runtime-expected-path";

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

export type BashRunnerJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface BashJobSnapshot {
  jobId: string;
  status: BashRunnerJobStatus;
  command: string;
  initialCwd: string;
  finalCwd?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutChars: number;
  stderrChars: number;
  stdoutPersisted: boolean;
  stderrPersisted: boolean;
  trackedEnvKeys: string[];
  stdoutPath?: string;
  stderrPath?: string;
}

export interface BashRunnerJobStartRequest extends BashExecutorRequest {
  jobId: string;
  maxOutputChars: number;
  persistOutputThresholdChars: number;
  persistOutputFiles?: boolean;
}

export interface BashRunnerJobQueryRequest {
  jobId: string;
}

export interface BashRunnerJobWaitRequest extends BashRunnerJobQueryRequest {
  timeoutMs?: number;
}

export interface BashRunnerJobCancelRequest extends BashRunnerJobQueryRequest {
  timeoutMs?: number;
}

export interface BashRunnerJobResponse extends BashJobSnapshot {
  ok: true;
}

export interface BashRunnerErrorResponse {
  ok: false;
  error: string;
  details?: JsonObject;
}

export type BashRunnerResponse = BashRunnerExecResponse | BashRunnerJobResponse | BashRunnerErrorResponse;
