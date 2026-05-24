import {constants as osConstants} from "node:os";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";

export const RUNNER_AGENT_KEY_HEADER = "x-runtime-agent-key";
export const RUNNER_PATH_SCOPED_HEADER = "x-runtime-agent-path-scoped";
export const RUNNER_EXPECTED_PATH_HEADER = "x-runtime-expected-path";
export const RUNNER_AUTHORIZATION_HEADER = "authorization";

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

const VALID_SIGNAL_NAMES = new Set<string>(Object.keys(osConstants.signals));

function invalidRunnerResponse(): never {
  throw new ToolError("Remote bash runner returned an invalid response.");
}

function readStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    invalidRunnerResponse();
  }

  return value;
}

function readOptionalStringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    invalidRunnerResponse();
  }

  return value;
}

function readNullableStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    invalidRunnerResponse();
  }

  return value;
}

function readNumberField(record: Record<string, unknown>, field: string): number {
  const value = record[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidRunnerResponse();
  }

  return value;
}

function readOptionalNumberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidRunnerResponse();
  }

  return value;
}

function readNullableNumberField(record: Record<string, unknown>, field: string): number | null {
  const value = record[field];
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidRunnerResponse();
  }

  return value;
}

function readOptionalNullableNumberField(record: Record<string, unknown>, field: string): number | null | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidRunnerResponse();
  }

  return value;
}

function readBooleanField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  if (typeof value !== "boolean") {
    invalidRunnerResponse();
  }

  return value;
}

function readStringArrayField(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    invalidRunnerResponse();
  }

  return value;
}

function isSignal(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && VALID_SIGNAL_NAMES.has(value);
}

function readSignal(value: unknown): NodeJS.Signals {
  if (isSignal(value)) {
    return value;
  }

  invalidRunnerResponse();
}

function readNullableSignalField(record: Record<string, unknown>, field: string): NodeJS.Signals | null {
  const value = record[field];
  if (value === null) {
    return null;
  }

  return readSignal(value);
}

function readOptionalNullableSignalField(
  record: Record<string, unknown>,
  field: string,
): NodeJS.Signals | null | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }

  return readSignal(value);
}

function readPersistedEnvEntries(record: Record<string, unknown>): PersistedEnvEntry[] {
  const value = record.persistedEnvEntries;
  if (!Array.isArray(value)) {
    invalidRunnerResponse();
  }

  return value.map((entry) => {
    if (!isRecord(entry)) {
      invalidRunnerResponse();
    }

    return {
      key: readStringField(entry, "key"),
      present: readBooleanField(entry, "present"),
      value: readStringField(entry, "value"),
    };
  });
}

function readOptionalDetails(record: Record<string, unknown>): JsonObject | undefined {
  const value = record.details;
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    invalidRunnerResponse();
  }

  return value;
}

function isBashRunnerJobStatus(value: unknown): value is BashRunnerJobStatus {
  return value === "running" || value === "completed" || value === "failed" || value === "cancelled";
}

function parseBashRunnerErrorResponse(record: Record<string, unknown>): BashRunnerErrorResponse {
  return {
    ok: false,
    error: readStringField(record, "error"),
    ...(record.details === undefined ? {} : {details: readOptionalDetails(record)}),
  };
}

export function parseBashRunnerExecResponse(value: unknown): BashRunnerExecResponse {
  if (!isRecord(value) || value.ok !== true) {
    invalidRunnerResponse();
  }

  return {
    ok: true,
    shell: readStringField(value, "shell"),
    finalCwd: readStringField(value, "finalCwd"),
    durationMs: readNumberField(value, "durationMs"),
    timeoutMs: readNumberField(value, "timeoutMs"),
    exitCode: readNullableNumberField(value, "exitCode"),
    signal: readNullableSignalField(value, "signal"),
    timedOut: readBooleanField(value, "timedOut"),
    aborted: readBooleanField(value, "aborted"),
    abortReason: readNullableStringField(value, "abortReason"),
    interrupted: readBooleanField(value, "interrupted"),
    success: readBooleanField(value, "success"),
    stdout: readStringField(value, "stdout"),
    stderr: readStringField(value, "stderr"),
    stdoutTruncated: readBooleanField(value, "stdoutTruncated"),
    stderrTruncated: readBooleanField(value, "stderrTruncated"),
    stdoutChars: readNumberField(value, "stdoutChars"),
    stderrChars: readNumberField(value, "stderrChars"),
    stdoutPersisted: readBooleanField(value, "stdoutPersisted"),
    stderrPersisted: readBooleanField(value, "stderrPersisted"),
    noOutput: readBooleanField(value, "noOutput"),
    trackedEnvKeys: readStringArrayField(value, "trackedEnvKeys"),
    persistedEnvEntries: readPersistedEnvEntries(value),
    ...(value.stdoutPath === undefined ? {} : {stdoutPath: readOptionalStringField(value, "stdoutPath")}),
    ...(value.stderrPath === undefined ? {} : {stderrPath: readOptionalStringField(value, "stderrPath")}),
  };
}

export function parseBashRunnerJobResponse(value: unknown): BashRunnerJobResponse {
  if (!isRecord(value) || value.ok !== true || !isBashRunnerJobStatus(value.status)) {
    invalidRunnerResponse();
  }

  const exitCode = readOptionalNullableNumberField(value, "exitCode");
  const signal = readOptionalNullableSignalField(value, "signal");

  return {
    ok: true,
    jobId: readStringField(value, "jobId"),
    status: value.status,
    command: readStringField(value, "command"),
    initialCwd: readStringField(value, "initialCwd"),
    startedAt: readNumberField(value, "startedAt"),
    timedOut: readBooleanField(value, "timedOut"),
    stdout: readStringField(value, "stdout"),
    stderr: readStringField(value, "stderr"),
    stdoutTruncated: readBooleanField(value, "stdoutTruncated"),
    stderrTruncated: readBooleanField(value, "stderrTruncated"),
    stdoutChars: readNumberField(value, "stdoutChars"),
    stderrChars: readNumberField(value, "stderrChars"),
    stdoutPersisted: readBooleanField(value, "stdoutPersisted"),
    stderrPersisted: readBooleanField(value, "stderrPersisted"),
    trackedEnvKeys: readStringArrayField(value, "trackedEnvKeys"),
    ...(value.finalCwd === undefined ? {} : {finalCwd: readOptionalStringField(value, "finalCwd")}),
    ...(value.finishedAt === undefined ? {} : {finishedAt: readOptionalNumberField(value, "finishedAt")}),
    ...(value.durationMs === undefined ? {} : {durationMs: readOptionalNumberField(value, "durationMs")}),
    ...(exitCode === undefined ? {} : {exitCode}),
    ...(signal === undefined ? {} : {signal}),
    ...(value.stdoutPath === undefined ? {} : {stdoutPath: readOptionalStringField(value, "stdoutPath")}),
    ...(value.stderrPath === undefined ? {} : {stderrPath: readOptionalStringField(value, "stderrPath")}),
  };
}

export function parseBashRunnerAbortResponse(value: unknown): BashRunnerAbortResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    invalidRunnerResponse();
  }

  return {
    ok: value.ok,
    aborted: readBooleanField(value, "aborted"),
  };
}

export function parseBashRunnerResponse(value: unknown): BashRunnerResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    invalidRunnerResponse();
  }

  if (!value.ok) {
    return parseBashRunnerErrorResponse(value);
  }
  if ("shell" in value) {
    return parseBashRunnerExecResponse(value);
  }
  if ("jobId" in value) {
    return parseBashRunnerJobResponse(value);
  }

  invalidRunnerResponse();
}
