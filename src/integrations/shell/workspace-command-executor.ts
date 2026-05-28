import {randomUUID} from "node:crypto";

import {ToolError} from "../../kernel/agent/exceptions.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";
import type {BashExecutionResult, BashJobSnapshot, PersistedEnvEntry} from "./bash-protocol.js";
import type {CommandExecutor, CommandExecutorExecInput, CommandExecutorJob, CommandExecutorJobStartInput} from "./bash-runner.js";
import {SAFE_SHELL} from "./environment.js";
import type {WorkspaceExecAction, WorkspaceExecResponse, WorkspaceProcessSnapshot} from "./workspace-exec-protocol.js";

const WORKSPACE_EXEC_CONFIG_KEYS = [
  "PANDA_WORKSPACE_EXEC_MANAGER_URL",
  "PANDA_WORKSPACE_EXEC_ENVIRONMENT_ID",
  "PANDA_WORKSPACE_EXEC_TOKEN",
] as const;

export interface WorkspaceCommandExecutorOptions {
  managerUrl: string;
  environmentId: string;
  credential: string;
  fetchImpl?: typeof fetch;
  shell?: string;
}

export function resolveWorkspaceCommandExecutorFromEnv(env: NodeJS.ProcessEnv = process.env): WorkspaceCommandExecutor | undefined {
  const values = WORKSPACE_EXEC_CONFIG_KEYS.map((key) => trimToNull(env[key]));
  const present = values.filter((value) => value !== null).length;
  if (present === 0) {
    return undefined;
  }
  if (present !== WORKSPACE_EXEC_CONFIG_KEYS.length) {
    throw new Error(`Workspace exec runner config requires all of ${WORKSPACE_EXEC_CONFIG_KEYS.join(", ")} or none.`);
  }
  const [managerUrl, environmentId, credential] = values as [string, string, string];
  return new WorkspaceCommandExecutor({managerUrl, environmentId, credential});
}

function endpoint(baseUrl: string): string {
  return new URL("/workspaces/exec", baseUrl).toString();
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildStateWrappedCommand(command: string, trackedEnvKeys: readonly string[], token: string): string {
  const begin = `__PANDA_STATE_${token}_BEGIN__`;
  const end = `__PANDA_STATE_${token}_END__`;
  const lines = [
    command,
    "__panda_status=$?",
    'if [ "$__panda_status" -eq 0 ]; then',
    `  printf '\\n%s\\n' ${shellQuote(begin)} >&2`,
    "  pwd -P >&2",
  ];
  for (const key of trackedEnvKeys) {
    lines.push(`  if [ "\${${key}+x}" = "x" ]; then`);
    lines.push(`    printf '%s\\tpresent\\t' ${shellQuote(key)} >&2`);
    lines.push(`    printf '%s' "\${${key}}" | base64 | tr -d '\\n' >&2`);
    lines.push("    printf '\\n' >&2");
    lines.push("  else");
    lines.push(`    printf '%s\\tabsent\\t\\n' ${shellQuote(key)} >&2`);
    lines.push("  fi");
  }
  lines.push(`  printf '%s\\n' ${shellQuote(end)} >&2`, "fi", 'exit "$__panda_status"');
  return lines.join("\n");
}

function parseStateFromStderr(stderr: string, token: string): {stderr: string; finalCwd?: string; persistedEnvEntries: PersistedEnvEntry[]} {
  const begin = `__PANDA_STATE_${token}_BEGIN__`;
  const end = `__PANDA_STATE_${token}_END__`;
  const beginIndex = stderr.lastIndexOf(begin);
  const endIndex = stderr.lastIndexOf(end);
  if (beginIndex < 0 || endIndex < beginIndex) {
    return {stderr, persistedEnvEntries: []};
  }
  const stateStart = beginIndex + begin.length;
  const state = stderr.slice(stateStart, endIndex).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  const cleaned = `${stderr.slice(0, beginIndex)}${stderr.slice(endIndex + end.length)}`.replace(/^\r?\n/, "");
  const lines = state.split(/\r?\n/);
  const finalCwd = trimToNull(lines.shift() ?? null) ?? undefined;
  const entries: PersistedEnvEntry[] = [];
  for (const line of lines) {
    if (!line) continue;
    const [key, present, encoded = ""] = line.split("\t");
    if (!key || (present !== "present" && present !== "absent")) continue;
    entries.push({
      key,
      present: present === "present",
      value: present === "present" ? Buffer.from(encoded, "base64").toString("utf8") : "",
    });
  }
  return {stderr: cleaned, finalCwd, persistedEnvEntries: entries};
}

function readWorkspaceResponse(value: unknown): WorkspaceExecResponse {
  if (!isRecord(value) || value.ok !== true || !isRecord(value.process)) {
    throw new ToolError("Workspace exec manager returned an invalid response.");
  }
  return value as unknown as WorkspaceExecResponse;
}

function toExecutionResult(process: WorkspaceProcessSnapshot, request: CommandExecutorExecInput["request"], shell: string): BashExecutionResult {
  const interrupted = process.timedOut || process.aborted || process.status === "cancelled" || (process.signal !== null && process.signal !== undefined && process.exitCode == null);
  return {
    shell,
    finalCwd: process.finalCwd ?? request.cwd,
    durationMs: process.durationMs ?? 0,
    timeoutMs: request.timeoutMs,
    exitCode: process.exitCode ?? null,
    signal: process.signal ?? null,
    timedOut: process.timedOut,
    aborted: process.aborted,
    abortReason: process.abortReason,
    interrupted,
    success: !interrupted && process.status === "completed" && process.exitCode === 0,
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutTruncated: process.stdoutTruncated,
    stderrTruncated: process.stderrTruncated,
    stdoutChars: process.stdoutChars,
    stderrChars: process.stderrChars,
    stdoutPersisted: false,
    stderrPersisted: false,
    noOutput: process.stdoutChars === 0 && process.stderrChars === 0,
    trackedEnvKeys: request.trackedEnvKeys,
    persistedEnvEntries: process.persistedEnvEntries ?? [],
  };
}

function toJobSnapshot(jobId: string, process: WorkspaceProcessSnapshot): BashJobSnapshot {
  return {
    jobId,
    status: process.status,
    command: process.command,
    initialCwd: process.initialCwd,
    ...(process.finalCwd ? {finalCwd: process.finalCwd} : {}),
    startedAt: process.startedAt,
    ...(process.finishedAt ? {finishedAt: process.finishedAt} : {}),
    ...(process.durationMs !== undefined ? {durationMs: process.durationMs} : {}),
    ...(process.exitCode !== undefined ? {exitCode: process.exitCode} : {}),
    ...(process.signal !== undefined ? {signal: process.signal} : {}),
    timedOut: process.timedOut,
    stdout: process.stdout,
    stderr: process.stderr,
    stdoutTruncated: process.stdoutTruncated,
    stderrTruncated: process.stderrTruncated,
    stdoutChars: process.stdoutChars,
    stderrChars: process.stderrChars,
    stdoutPersisted: false,
    stderrPersisted: false,
    trackedEnvKeys: process.trackedEnvKeys,
  };
}

export class WorkspaceCommandExecutor implements CommandExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly shell: string;

  constructor(private readonly options: WorkspaceCommandExecutorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.shell = options.shell ?? SAFE_SHELL;
  }

  async execute(input: CommandExecutorExecInput): Promise<{result: BashExecutionResult; spawnErrorMessage?: string; spawnErrorDetails?: Record<string, unknown>}> {
    const token = randomUUID().replaceAll("-", "_");
    const processId = `runner-fg:${input.request.requestId}:${token}`;
    const abortCancel = async () => {
      await this.send({action: "cancel", environmentId: this.options.environmentId, processId, timeoutMs: 1_000}).catch(() => undefined);
    };
    let abortListener: (() => void) | undefined;
    let timeoutFired = false;
    const timeout = setTimeout(() => {
      timeoutFired = true;
      void abortCancel();
    }, input.request.timeoutMs);
    timeout.unref();
    if (input.signal.aborted) {
      await abortCancel();
    } else {
      abortListener = () => { void abortCancel(); };
      input.signal.addEventListener("abort", abortListener, {once: true});
    }
    try {
      const response = await this.send({
        action: "start",
        environmentId: this.options.environmentId,
        request: {
          mode: "foreground",
          processId,
          command: buildStateWrappedCommand(input.request.command, input.request.trackedEnvKeys, token),
          cwd: input.cwd,
          env: input.request.env,
          timeoutMs: input.request.timeoutMs,
          trackedEnvKeys: input.request.trackedEnvKeys,
          maxOutputChars: input.request.maxOutputChars,
        },
      });
      const parsed = parseStateFromStderr(response.process.stderr, token);
      const process = {
        ...response.process,
        command: input.request.command,
        initialCwd: input.cwd,
        stderr: parsed.stderr,
        stderrChars: parsed.stderr.length,
        stderrTruncated: parsed.stderr.length > input.request.maxOutputChars || response.process.stderrTruncated,
        ...(response.process.status === "completed" && response.process.exitCode === 0 && parsed.finalCwd ? {finalCwd: parsed.finalCwd} : {}),
        persistedEnvEntries: response.process.status === "completed" && response.process.exitCode === 0 ? parsed.persistedEnvEntries : [],
      };
      if (timeoutFired && !process.aborted) {
        process.timedOut = true;
        process.status = "cancelled";
      }
      if (input.signal.aborted && !process.aborted && !process.timedOut) {
        process.aborted = true;
        process.abortReason = input.signal.reason instanceof Error ? input.signal.reason.message : "Command aborted.";
        process.status = "cancelled";
      }
      return {result: toExecutionResult(process, input.request, this.shell)};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {result: toExecutionResult({
        processId,
        status: "failed",
        command: input.request.command,
        initialCwd: input.cwd,
        startedAt: Date.now(),
        finishedAt: Date.now(),
        durationMs: 0,
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        abortReason: null,
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutChars: 0,
        stderrChars: 0,
        stdoutPersisted: false,
        stderrPersisted: false,
        trackedEnvKeys: input.request.trackedEnvKeys,
      }, input.request, this.shell), spawnErrorMessage: message, spawnErrorDetails: {error: message}};
    } finally {
      clearTimeout(timeout);
      if (abortListener) input.signal.removeEventListener("abort", abortListener);
    }
  }

  async startJob(input: CommandExecutorJobStartInput): Promise<CommandExecutorJob> {
    const processId = `runner-job:${input.request.jobId}`;
    const response = await this.send({
      action: "start",
      environmentId: this.options.environmentId,
      request: {
        mode: "background",
        processId,
        command: input.request.command,
        cwd: input.cwd,
        env: input.request.env,
        timeoutMs: input.request.timeoutMs,
        trackedEnvKeys: input.request.trackedEnvKeys,
        maxOutputChars: input.request.maxOutputChars,
      },
    });
    return new WorkspaceCommandExecutorJob(input.request.jobId, processId, this, response.process);
  }

  get environmentId(): string {
    return this.options.environmentId;
  }

  async processAction(action: WorkspaceExecAction): Promise<WorkspaceProcessSnapshot> {
    return (await this.send(action)).process;
  }

  private async send(action: WorkspaceExecAction): Promise<WorkspaceExecResponse> {
    const response = await this.fetchImpl(endpoint(this.options.managerUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(action),
    });
    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try { payload = JSON.parse(text) as unknown; } catch { payload = text; }
    }
    if (!response.ok) {
      const message = isRecord(payload) && typeof payload.error === "string" ? payload.error : `Workspace exec manager request failed with status ${response.status}.`;
      throw new ToolError(message, {details: {statusCode: response.status}});
    }
    return readWorkspaceResponse(payload);
  }
}

class WorkspaceCommandExecutorJob implements CommandExecutorJob {
  private latest: BashJobSnapshot;
  constructor(
    private readonly jobId: string,
    private readonly processId: string,
    private readonly executor: WorkspaceCommandExecutor,
    initial: WorkspaceProcessSnapshot,
  ) {
    this.latest = toJobSnapshot(jobId, initial);
  }

  async snapshot(): Promise<BashJobSnapshot> {
    const process = await this.executor.processAction({action: "status", environmentId: this.executor.environmentId, processId: this.processId});
    this.latest = toJobSnapshot(this.jobId, process);
    return this.latest;
  }

  async wait(timeoutMs?: number): Promise<BashJobSnapshot> {
    const process = await this.executor.processAction({action: "wait", environmentId: this.executor.environmentId, processId: this.processId, ...(timeoutMs === undefined ? {} : {timeoutMs})});
    this.latest = toJobSnapshot(this.jobId, process);
    return this.latest;
  }

  async cancel(timeoutMs?: number): Promise<BashJobSnapshot> {
    const process = await this.executor.processAction({action: "cancel", environmentId: this.executor.environmentId, processId: this.processId, ...(timeoutMs === undefined ? {} : {timeoutMs})});
    this.latest = toJobSnapshot(this.jobId, process);
    return this.latest;
  }
}
