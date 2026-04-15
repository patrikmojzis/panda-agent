import {randomUUID} from "node:crypto";

import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {
    ThreadBashJobRecord,
    ThreadBashJobStatus,
    ThreadBashJobUpdate,
} from "../../domain/threads/runtime/types.js";
import {
    buildRunnerEndpoint,
    buildRunnerRequestHeaders,
    makeNetworkTimeoutSignal,
    parseRunnerResponse,
    readRunnerError,
    resolveBashExecutionMode,
    resolveRunnerUrl,
    resolveRunnerUrlTemplate,
} from "./bash-executor.js";
import {ManagedBashJob} from "./bash-background-job.js";
import {readBashSpawnPreflightFailure} from "./bash-spawn-preflight.js";
import type {
    BashJobSnapshot,
    BashRunnerJobCancelRequest,
    BashRunnerJobQueryRequest,
    BashRunnerJobResponse,
    BashRunnerJobStartRequest,
    BashRunnerJobWaitRequest,
} from "./bash-protocol.js";
import type {ShellExecutionContext} from "./types.js";

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;
const DEFAULT_CANCEL_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_REMOTE_TIMEOUT_BUFFER_MS = 5_000;

interface BashJobContext extends ShellExecutionContext {
  threadId?: string;
  runId?: string;
  agentKey?: string;
}

export interface BashJobServiceStartOptions<TContext extends BashJobContext = BashJobContext> {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  resolvedEnv?: Record<string, string>;
  trackedEnvKeys: string[];
  maxOutputChars: number;
  persistOutputThresholdChars: number;
  outputDirectory: string;
  secretValues: readonly string[];
  run: RunContext<TContext>;
}

export interface BashJobServiceOptions {
  store: ThreadRuntimeStore;
  env?: NodeJS.ProcessEnv;
  shell?: string;
  fetchImpl?: typeof fetch;
}

export type BackgroundJobTerminalHandler = (record: ThreadBashJobRecord) => Promise<void> | void;

interface RemoteJobHandle {
  jobId: string;
  runnerUrl: string;
  headers: Record<string, string>;
}

function isTerminalStatus(status: ThreadBashJobStatus | BashJobSnapshot["status"]): boolean {
  return status !== "running";
}

function readThreadId(context: BashJobContext | undefined): string {
  const threadId = context?.threadId?.trim();
  if (!threadId) {
    throw new ToolError("Background bash jobs require the current Panda session thread.");
  }

  return threadId;
}

function readAgentKey(context: BashJobContext | undefined): string {
  const agentKey = context?.agentKey?.trim();
  if (!agentKey) {
    throw new ToolError("Remote background bash requires agentKey in the current Panda session context.");
  }

  return agentKey;
}

function redactSecretsInString(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (!secret) {
      continue;
    }

    redacted = redacted.split(secret).join("[redacted]");
  }

  return redacted;
}

function sanitizeSnapshot(snapshot: BashJobSnapshot, secrets: readonly string[]): BashJobSnapshot {
  if (secrets.length === 0) {
    return snapshot;
  }

  return {
    ...snapshot,
    stdout: redactSecretsInString(snapshot.stdout, secrets),
    stderr: redactSecretsInString(snapshot.stderr, secrets),
  };
}

function mergeLiveSnapshot(record: ThreadBashJobRecord, snapshot: BashJobSnapshot): ThreadBashJobRecord {
  return {
    ...record,
    status: snapshot.status,
    finalCwd: snapshot.finalCwd ?? record.finalCwd,
    finishedAt: snapshot.finishedAt ?? record.finishedAt,
    durationMs: snapshot.durationMs ?? record.durationMs,
    exitCode: snapshot.exitCode ?? record.exitCode,
    signal: snapshot.signal ?? record.signal,
    timedOut: snapshot.timedOut,
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    stdoutChars: snapshot.stdoutChars,
    stderrChars: snapshot.stderrChars,
    stdoutTruncated: snapshot.stdoutTruncated,
    stderrTruncated: snapshot.stderrTruncated,
    stdoutPersisted: snapshot.stdoutPersisted,
    stderrPersisted: snapshot.stderrPersisted,
    stdoutPath: snapshot.stdoutPath ?? record.stdoutPath,
    stderrPath: snapshot.stderrPath ?? record.stderrPath,
    trackedEnvKeys: [...snapshot.trackedEnvKeys],
  };
}

function snapshotToUpdate(snapshot: BashJobSnapshot): ThreadBashJobUpdate {
  return {
    status: snapshot.status,
    finalCwd: snapshot.finalCwd ?? null,
    finishedAt: snapshot.finishedAt ?? null,
    durationMs: snapshot.durationMs ?? null,
    exitCode: snapshot.exitCode ?? null,
    signal: snapshot.signal ?? null,
    timedOut: snapshot.timedOut,
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    stdoutChars: snapshot.stdoutChars,
    stderrChars: snapshot.stderrChars,
    stdoutTruncated: snapshot.stdoutTruncated,
    stderrTruncated: snapshot.stderrTruncated,
    stdoutPersisted: snapshot.stdoutPersisted,
    stderrPersisted: snapshot.stderrPersisted,
    stdoutPath: snapshot.stdoutPath ?? null,
    stderrPath: snapshot.stderrPath ?? null,
    trackedEnvKeys: [...snapshot.trackedEnvKeys],
  };
}

function lostReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Background bash job tracking was lost: ${message}`;
}

async function parseJobResponse(response: Response): Promise<BashRunnerJobResponse> {
  const payload = await parseRunnerResponse(response);
  if (!payload.ok || !("jobId" in payload)) {
    throw new ToolError("Remote bash runner returned an invalid background job response.");
  }

  return payload as BashRunnerJobResponse;
}

export class BashJobService {
  private readonly store: ThreadRuntimeStore;
  private readonly env: NodeJS.ProcessEnv;
  private readonly shell: string;
  private readonly fetchImpl: typeof fetch;
  private readonly localJobs = new Map<string, ManagedBashJob>();
  private readonly remoteJobs = new Map<string, RemoteJobHandle>();
  private readonly secretValuesByJobId = new Map<string, readonly string[]>();
  private readonly quietJobIds = new Set<string>();
  private onTerminalJob?: BackgroundJobTerminalHandler;

  constructor(options: BashJobServiceOptions) {
    this.store = options.store;
    this.env = options.env ?? process.env;
    this.shell = options.shell ?? this.env.SHELL ?? "/bin/zsh";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  setBackgroundCompletionHandler(handler?: BackgroundJobTerminalHandler): void {
    this.onTerminalJob = handler;
  }

  async start<TContext extends BashJobContext>(
    options: BashJobServiceStartOptions<TContext>,
  ): Promise<ThreadBashJobRecord> {
    const threadId = readThreadId(options.run.context);
    const mode = resolveBashExecutionMode(this.env);
    const jobId = randomUUID();

    this.secretValuesByJobId.set(jobId, [...options.secretValues]);

    if (mode === "local") {
      const spawnFailure = await readBashSpawnPreflightFailure({
        cwd: options.cwd,
        shell: this.shell,
        scope: "local",
      });
      if (spawnFailure) {
        this.secretValuesByJobId.delete(jobId);
        throw new ToolError(spawnFailure.message, { details: spawnFailure.details });
      }

      const childEnv = {
        ...this.env,
        ...(options.resolvedEnv ?? {}),
        ...(options.run.context?.shell?.env ?? {}),
        ...(options.env ?? {}),
      };
      let job: ManagedBashJob;
      try {
        job = await ManagedBashJob.start({
          jobId,
          command: options.command,
          cwd: options.cwd,
          childEnv,
          shell: this.shell,
          timeoutMs: options.timeoutMs,
          trackedEnvKeys: options.trackedEnvKeys,
          maxOutputChars: options.maxOutputChars,
          persistOutputThresholdChars: options.persistOutputThresholdChars,
          persistOutputFiles: options.secretValues.length === 0,
          outputDirectory: options.outputDirectory,
        });
      } catch (error) {
        this.secretValuesByJobId.delete(jobId);
        throw error;
      }

      this.localJobs.set(jobId, job);
      const snapshot = sanitizeSnapshot(job.snapshot(), options.secretValues);

      let record: ThreadBashJobRecord;
      try {
        record = await this.store.createBashJob({
          id: jobId,
          threadId,
          runId: options.run.context?.runId,
          command: options.command,
          mode,
          initialCwd: options.cwd,
          startedAt: snapshot.startedAt,
          trackedEnvKeys: options.trackedEnvKeys,
        });
      } catch (error) {
        this.localJobs.delete(jobId);
        this.secretValuesByJobId.delete(jobId);
        await job.cancel(DEFAULT_CANCEL_WAIT_TIMEOUT_MS).catch(() => undefined);
        throw error;
      }

      if (isTerminalStatus(snapshot.status)) {
        return this.finalizeJob(record, snapshot);
      }

      void this.watchLocalJob(jobId, job);
      return mergeLiveSnapshot(record, snapshot);
    }

    const runnerUrlTemplate = resolveRunnerUrlTemplate(this.env);
    if (!runnerUrlTemplate) {
      throw new ToolError("Remote background bash requires PANDA_RUNNER_URL_TEMPLATE.");
    }

    const agentKey = readAgentKey(options.run.context);
    const runnerUrl = resolveRunnerUrl(runnerUrlTemplate, agentKey);
    const headers = buildRunnerRequestHeaders(agentKey, runnerUrlTemplate, runnerUrl);
    const request: BashRunnerJobStartRequest = {
      jobId,
      command: options.command,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      trackedEnvKeys: options.trackedEnvKeys,
      maxOutputChars: options.maxOutputChars,
      persistOutputThresholdChars: options.persistOutputThresholdChars,
      persistOutputFiles: options.secretValues.length === 0,
      env: Object.keys({
        ...(options.resolvedEnv ?? {}),
        ...(options.run.context?.shell?.env ?? {}),
        ...(options.env ?? {}),
      }).length > 0
        ? {
          ...(options.resolvedEnv ?? {}),
          ...(options.run.context?.shell?.env ?? {}),
          ...(options.env ?? {}),
        }
        : undefined,
    };

    let snapshot: BashJobSnapshot;
    try {
      const response = await this.fetchImpl(buildRunnerEndpoint(runnerUrl, "jobs/start"), {
        method: "POST",
        headers,
        body: JSON.stringify(request),
        signal: makeNetworkTimeoutSignal(DEFAULT_REMOTE_TIMEOUT_BUFFER_MS),
      });
      if (!response.ok) {
        await readRunnerError(response);
      }

      snapshot = sanitizeSnapshot(await parseJobResponse(response), options.secretValues);
    } catch (error) {
      await this.cancelRemoteStart(jobId, runnerUrl, headers);
      this.secretValuesByJobId.delete(jobId);
      throw error;
    }

    let record: ThreadBashJobRecord;
    try {
      record = await this.store.createBashJob({
        id: jobId,
        threadId,
        runId: options.run.context?.runId,
        command: options.command,
        mode,
        initialCwd: options.cwd,
        startedAt: snapshot.startedAt,
        trackedEnvKeys: options.trackedEnvKeys,
      });
    } catch (error) {
      await this.cancelRemoteStart(jobId, runnerUrl, headers);
      this.secretValuesByJobId.delete(jobId);
      throw error;
    }

    if (isTerminalStatus(snapshot.status)) {
      return this.finalizeJob(record, snapshot);
    }

    const handle: RemoteJobHandle = {
      jobId,
      runnerUrl,
      headers,
    };
    this.remoteJobs.set(jobId, handle);

    void this.watchRemoteJob(jobId);
    return mergeLiveSnapshot(record, snapshot);
  }

  async status(threadId: string, jobId: string): Promise<ThreadBashJobRecord> {
    const record = await this.requireJob(threadId, jobId);
    if (isTerminalStatus(record.status)) {
      return record;
    }

    return this.readLiveJob(record, "status", DEFAULT_WAIT_TIMEOUT_MS);
  }

  async wait(threadId: string, jobId: string, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS): Promise<ThreadBashJobRecord> {
    const record = await this.requireJob(threadId, jobId);
    if (isTerminalStatus(record.status)) {
      return record;
    }

    return this.readLiveJob(record, "wait", timeoutMs);
  }

  async cancel(threadId: string, jobId: string): Promise<ThreadBashJobRecord> {
    const record = await this.requireJob(threadId, jobId);
    if (isTerminalStatus(record.status)) {
      this.quietJobIds.delete(jobId);
      return record;
    }

    const localJob = this.localJobs.get(jobId);
    if (localJob) {
      const snapshot = sanitizeSnapshot(
        await localJob.cancel(DEFAULT_CANCEL_WAIT_TIMEOUT_MS),
        this.secretValuesByJobId.get(jobId) ?? [],
      );
      if (isTerminalStatus(snapshot.status)) {
        return this.finalizeJob(record, snapshot);
      }

      return mergeLiveSnapshot(record, snapshot);
    }

    const remoteJob = this.remoteJobs.get(jobId);
    if (remoteJob) {
      const response = await this.fetchImpl(buildRunnerEndpoint(remoteJob.runnerUrl, "jobs/cancel"), {
        method: "POST",
        headers: remoteJob.headers,
        body: JSON.stringify({
          jobId,
          timeoutMs: DEFAULT_CANCEL_WAIT_TIMEOUT_MS,
        } satisfies BashRunnerJobCancelRequest),
        signal: makeNetworkTimeoutSignal(DEFAULT_REMOTE_TIMEOUT_BUFFER_MS),
      });
      if (!response.ok) {
        await readRunnerError(response);
      }

      const snapshot = sanitizeSnapshot(
        await parseJobResponse(response),
        this.secretValuesByJobId.get(jobId) ?? [],
      );
      if (isTerminalStatus(snapshot.status)) {
        return this.finalizeJob(record, snapshot);
      }

      return mergeLiveSnapshot(record, snapshot);
    }

    return this.markLost(record, "Live background bash state was missing.");
  }

  async cancelThreadJobs(threadId: string): Promise<void> {
    let jobs: readonly ThreadBashJobRecord[];
    try {
      jobs = await this.store.listBashJobs(threadId);
    } catch {
      return;
    }

    const runningJobIds = jobs
      .filter((job) => job.status === "running")
      .map((job) => job.id);
    for (const jobId of runningJobIds) {
      this.quietJobIds.add(jobId);
    }

    await Promise.all(runningJobIds.map(async (jobId) => {
      try {
        await this.cancel(threadId, jobId);
      } catch {
        // Reset-driven cleanup is best effort. Keep the thread replacement moving.
      }
    }));
  }

  async close(): Promise<void> {
    await Promise.all([
      ...[...this.localJobs.keys()].map((jobId) => this.localJobs.get(jobId)?.cancel(100).catch(() => undefined)),
      ...[...this.remoteJobs.values()].map(async (job) => {
        try {
          await this.fetchImpl(buildRunnerEndpoint(job.runnerUrl, "jobs/cancel"), {
            method: "POST",
            headers: job.headers,
            body: JSON.stringify({
              jobId: job.jobId,
              timeoutMs: 100,
            } satisfies BashRunnerJobCancelRequest),
            signal: makeNetworkTimeoutSignal(DEFAULT_REMOTE_TIMEOUT_BUFFER_MS),
          });
        } catch {
          // Best effort on shutdown.
        }
      }),
    ]);
    this.localJobs.clear();
    this.remoteJobs.clear();
    this.secretValuesByJobId.clear();
    this.quietJobIds.clear();
  }

  private async requireJob(threadId: string, jobId: string): Promise<ThreadBashJobRecord> {
    let record: ThreadBashJobRecord;
    try {
      record = await this.store.getBashJob(jobId);
    } catch {
      throw new ToolError(`Unknown bash job ${jobId}.`);
    }

    if (record.threadId !== threadId) {
      throw new ToolError("Background bash jobs are only available inside the thread that created them.");
    }

    return record;
  }

  private async watchLocalJob(jobId: string, job: ManagedBashJob): Promise<void> {
    try {
      const record = await this.store.getBashJob(jobId);
      if (record.status !== "running") {
        return;
      }

      const snapshot = sanitizeSnapshot(
        await job.wait(2_147_000_000),
        this.secretValuesByJobId.get(jobId) ?? [],
      );
      await this.finalizeJob(record, snapshot, { notify: true });
    } catch (error) {
      try {
        const record = await this.store.getBashJob(jobId);
        if (record.status === "running") {
          await this.markLost(record, lostReason(error));
        }
      } catch {
        // Ignore missing jobs during shutdown races.
      }
    }
  }

  private async watchRemoteJob(jobId: string): Promise<void> {
    try {
      while (true) {
        const record = await this.store.getBashJob(jobId);
        if (record.status !== "running") {
          return;
        }

        const live = await this.readRemoteSnapshot(jobId, "wait", 60_000);
        if (!isTerminalStatus(live.status)) {
          continue;
        }

        await this.finalizeJob(record, live, { notify: true });
        return;
      }
    } catch (error) {
      try {
        const record = await this.store.getBashJob(jobId);
        if (record.status === "running") {
          await this.markLost(record, lostReason(error));
        }
      } catch {
        // Ignore missing jobs during shutdown races.
      }
    }
  }

  private async readLiveJob(
    record: ThreadBashJobRecord,
    mode: "status" | "wait",
    timeoutMs: number,
  ): Promise<ThreadBashJobRecord> {
    const localJob = this.localJobs.get(record.id);
    if (localJob) {
      const snapshot = sanitizeSnapshot(
        mode === "wait" ? await localJob.wait(timeoutMs) : localJob.snapshot(),
        this.secretValuesByJobId.get(record.id) ?? [],
      );
      if (isTerminalStatus(snapshot.status)) {
        return this.finalizeJob(record, snapshot);
      }

      return mergeLiveSnapshot(record, snapshot);
    }

    const remoteJob = this.remoteJobs.get(record.id);
    if (remoteJob) {
      const snapshot = await this.readRemoteSnapshot(record.id, mode, timeoutMs);
      if (isTerminalStatus(snapshot.status)) {
        return this.finalizeJob(record, snapshot);
      }

      return mergeLiveSnapshot(record, snapshot);
    }

    return this.markLost(record, "Live background bash state was missing.");
  }

  private async readRemoteSnapshot(
    jobId: string,
    mode: "status" | "wait",
    timeoutMs: number,
  ): Promise<BashJobSnapshot> {
    const remoteJob = this.remoteJobs.get(jobId);
    if (!remoteJob) {
      throw new ToolError(`Unknown remote bash job ${jobId}.`);
    }

    const request = mode === "wait"
      ? {
        jobId,
        timeoutMs,
      } satisfies BashRunnerJobWaitRequest
      : {
        jobId,
      } satisfies BashRunnerJobQueryRequest;
    const response = await this.fetchImpl(buildRunnerEndpoint(remoteJob.runnerUrl, mode === "wait" ? "jobs/wait" : "jobs/status"), {
      method: "POST",
      headers: remoteJob.headers,
      body: JSON.stringify(request),
      signal: makeNetworkTimeoutSignal(timeoutMs + DEFAULT_REMOTE_TIMEOUT_BUFFER_MS),
    });
    if (!response.ok) {
      await readRunnerError(response);
    }

    const snapshot = sanitizeSnapshot(
      await parseJobResponse(response),
      this.secretValuesByJobId.get(jobId) ?? [],
    );
    return snapshot;
  }

  private async cancelRemoteStart(jobId: string, runnerUrl: string, headers: Record<string, string>): Promise<void> {
    try {
      await this.fetchImpl(buildRunnerEndpoint(runnerUrl, "jobs/cancel"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          jobId,
          timeoutMs: DEFAULT_CANCEL_WAIT_TIMEOUT_MS,
        } satisfies BashRunnerJobCancelRequest),
        signal: makeNetworkTimeoutSignal(DEFAULT_REMOTE_TIMEOUT_BUFFER_MS),
      });
    } catch {
      // Best effort cleanup when start failed after a remote spawn race.
    }
  }

  private async finalizeJob(
    record: ThreadBashJobRecord,
    snapshot: BashJobSnapshot,
    options: { notify?: boolean } = {},
  ): Promise<ThreadBashJobRecord> {
    const current = await this.store.getBashJob(record.id);
    if (current.status !== "running") {
      this.localJobs.delete(record.id);
      this.remoteJobs.delete(record.id);
      this.secretValuesByJobId.delete(record.id);
      this.quietJobIds.delete(record.id);
      return current;
    }

    const updated = await this.store.updateBashJob(record.id, snapshotToUpdate(snapshot));
    const notify = options.notify === true && !this.quietJobIds.has(record.id);
    this.localJobs.delete(record.id);
    this.remoteJobs.delete(record.id);
    this.secretValuesByJobId.delete(record.id);
    this.quietJobIds.delete(record.id);
    if (notify) {
      await this.onTerminalJob?.(updated);
    }
    return updated;
  }

  private async markLost(record: ThreadBashJobRecord, reason: string): Promise<ThreadBashJobRecord> {
    const updated = await this.store.updateBashJob(record.id, {
      status: "lost",
      finishedAt: Date.now(),
      durationMs: Math.max(0, Date.now() - record.startedAt),
      statusReason: reason,
    });
    this.localJobs.delete(record.id);
    this.remoteJobs.delete(record.id);
    this.secretValuesByJobId.delete(record.id);
    this.quietJobIds.delete(record.id);
    return updated;
  }
}
