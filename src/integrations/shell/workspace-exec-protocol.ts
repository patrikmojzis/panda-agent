import type {PersistedEnvEntry} from "./bash-protocol.js";

export type WorkspaceExecActionName = "start" | "status" | "wait" | "cancel";
export type WorkspaceExecMode = "foreground" | "background";
export type WorkspaceProcessStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkspaceExecStartRequest {
  mode: WorkspaceExecMode;
  processId?: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
  trackedEnvKeys: string[];
  maxOutputChars: number;
}

export type WorkspaceExecAction =
  | {action: "start"; environmentId: string; request: WorkspaceExecStartRequest}
  | {action: "status"; environmentId: string; processId: string}
  | {action: "wait"; environmentId: string; processId: string; timeoutMs?: number}
  | {action: "cancel"; environmentId: string; processId: string; timeoutMs?: number};

export interface WorkspaceProcessSnapshot {
  processId: string;
  status: WorkspaceProcessStatus;
  command: string;
  initialCwd: string;
  finalCwd?: string;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  abortReason: string | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutChars: number;
  stderrChars: number;
  stdoutPersisted: false;
  stderrPersisted: false;
  trackedEnvKeys: string[];
  persistedEnvEntries?: PersistedEnvEntry[];
}

export interface WorkspaceExecResponse {
  ok: true;
  process: WorkspaceProcessSnapshot;
}
