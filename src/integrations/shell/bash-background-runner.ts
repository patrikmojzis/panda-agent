import {ToolError} from "../../kernel/agent/exceptions.js";
import type {
  BackgroundToolJobCompletion,
  BackgroundToolJobHandle,
  BackgroundToolJobSnapshot,
} from "../../domain/threads/runtime/tool-job-service.js";
import type {JsonObject} from "../../kernel/agent/types.js";
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
import {redactSecretsInString} from "./redaction.js";
import type {ShellExecutionContext} from "./types.js";

const DEFAULT_CANCEL_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_REMOTE_TIMEOUT_BUFFER_MS = 5_000;

interface BashBackgroundContext extends ShellExecutionContext {
  agentKey?: string;
}

export interface StartBashBackgroundJobOptions<TContext extends BashBackgroundContext = BashBackgroundContext> {
  jobId: string;
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
  context?: TContext;
  processEnv?: NodeJS.ProcessEnv;
  shell?: string;
  fetchImpl?: typeof fetch;
}

function readAgentKey(context: BashBackgroundContext | undefined): string {
  const agentKey = context?.agentKey?.trim();
  if (!agentKey) {
    throw new ToolError("Remote background bash requires agentKey in the current runtime session context.");
  }

  return agentKey;
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

function bashResultPayload(snapshot: BashJobSnapshot, mode: "local" | "remote"): JsonObject {
  return {
    jobId: snapshot.jobId,
    status: snapshot.status,
    command: snapshot.command,
    mode,
    initialCwd: snapshot.initialCwd,
    startedAt: snapshot.startedAt,
    timedOut: snapshot.timedOut,
    stdout: snapshot.stdout,
    stderr: snapshot.stderr,
    stdoutChars: snapshot.stdoutChars,
    stderrChars: snapshot.stderrChars,
    stdoutTruncated: snapshot.stdoutTruncated,
    stderrTruncated: snapshot.stderrTruncated,
    stdoutPersisted: snapshot.stdoutPersisted,
    stderrPersisted: snapshot.stderrPersisted,
    trackedEnvKeys: snapshot.trackedEnvKeys,
    sessionStateIsolated: true,
    ...(snapshot.finalCwd ? {finalCwd: snapshot.finalCwd} : {}),
    ...(snapshot.finishedAt !== undefined ? {finishedAt: snapshot.finishedAt} : {}),
    ...(snapshot.durationMs !== undefined ? {durationMs: snapshot.durationMs} : {}),
    ...(snapshot.exitCode !== undefined ? {exitCode: snapshot.exitCode} : {}),
    ...(snapshot.signal !== undefined ? {signal: snapshot.signal} : {}),
    ...(snapshot.stdoutPath ? {stdoutPath: snapshot.stdoutPath} : {}),
    ...(snapshot.stderrPath ? {stderrPath: snapshot.stderrPath} : {}),
  };
}

function snapshotToJobSnapshot(snapshot: BashJobSnapshot, mode: "local" | "remote"): BackgroundToolJobSnapshot {
  return {
    status: snapshot.status,
    result: bashResultPayload(snapshot, mode),
    progress: {
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      stdoutChars: snapshot.stdoutChars,
      stderrChars: snapshot.stderrChars,
    },
    ...(snapshot.finishedAt !== undefined ? {finishedAt: snapshot.finishedAt} : {}),
    ...(snapshot.durationMs !== undefined ? {durationMs: snapshot.durationMs} : {}),
  };
}

function snapshotToCompletion(snapshot: BashJobSnapshot, mode: "local" | "remote"): BackgroundToolJobCompletion {
  const next = snapshotToJobSnapshot(snapshot, mode);
  return {
    ...next,
    status: next.status === "running" ? "failed" : next.status,
  };
}

async function parseJobResponse(response: Response): Promise<BashRunnerJobResponse> {
  const payload = await parseRunnerResponse(response);
  if (!payload.ok || !("jobId" in payload)) {
    throw new ToolError("Remote bash runner returned an invalid background job response.");
  }

  return payload as BashRunnerJobResponse;
}

export async function startBashBackgroundJob<TContext extends BashBackgroundContext>(
  options: StartBashBackgroundJobOptions<TContext>,
): Promise<BackgroundToolJobHandle> {
  const processEnv = options.processEnv ?? process.env;
  const shell = options.shell ?? processEnv.SHELL ?? "/bin/zsh";
  const fetchImpl = options.fetchImpl ?? fetch;
  const mode = resolveBashExecutionMode(processEnv);

  if (mode === "local") {
    const spawnFailure = await readBashSpawnPreflightFailure({
      cwd: options.cwd,
      shell,
      scope: "local",
    });
    if (spawnFailure) {
      throw new ToolError(spawnFailure.message, { details: spawnFailure.details });
    }

    const childEnv = {
      ...processEnv,
      ...(options.resolvedEnv ?? {}),
      ...(options.context?.shell?.env ?? {}),
      ...(options.env ?? {}),
    };
    const job = await ManagedBashJob.start({
      jobId: options.jobId,
      command: options.command,
      cwd: options.cwd,
      childEnv,
      shell,
      timeoutMs: options.timeoutMs,
      trackedEnvKeys: options.trackedEnvKeys,
      maxOutputChars: options.maxOutputChars,
      persistOutputThresholdChars: options.persistOutputThresholdChars,
      persistOutputFiles: options.secretValues.length === 0,
      outputDirectory: options.outputDirectory,
    });
    const initial = sanitizeSnapshot(job.snapshot(), options.secretValues);

    return {
      startedAt: initial.startedAt,
      result: bashResultPayload(initial, mode),
      progress: snapshotToJobSnapshot(initial, mode).progress ?? undefined,
      snapshot: () => snapshotToJobSnapshot(sanitizeSnapshot(job.snapshot(), options.secretValues), mode),
      done: job.wait(2_147_000_000)
        .then((snapshot) => snapshotToCompletion(sanitizeSnapshot(snapshot, options.secretValues), mode)),
      cancel: async () => snapshotToJobSnapshot(
        sanitizeSnapshot(await job.cancel(DEFAULT_CANCEL_WAIT_TIMEOUT_MS), options.secretValues),
        mode,
      ),
    };
  }

  const runnerUrlTemplate = resolveRunnerUrlTemplate(processEnv);
  if (!runnerUrlTemplate) {
    throw new ToolError("Remote background bash requires RUNNER_URL_TEMPLATE.");
  }

  const agentKey = readAgentKey(options.context);
  const runnerUrl = resolveRunnerUrl(runnerUrlTemplate, agentKey);
  const headers = buildRunnerRequestHeaders(agentKey, runnerUrlTemplate, runnerUrl);
  const request: BashRunnerJobStartRequest = {
    jobId: options.jobId,
    command: options.command,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    trackedEnvKeys: options.trackedEnvKeys,
    maxOutputChars: options.maxOutputChars,
    persistOutputThresholdChars: options.persistOutputThresholdChars,
    persistOutputFiles: options.secretValues.length === 0,
    env: Object.keys({
      ...(options.resolvedEnv ?? {}),
      ...(options.context?.shell?.env ?? {}),
      ...(options.env ?? {}),
    }).length > 0
      ? {
        ...(options.resolvedEnv ?? {}),
        ...(options.context?.shell?.env ?? {}),
        ...(options.env ?? {}),
      }
      : undefined,
  };

  const response = await fetchImpl(buildRunnerEndpoint(runnerUrl, "jobs/start"), {
    method: "POST",
    headers,
    body: JSON.stringify(request),
    signal: makeNetworkTimeoutSignal(DEFAULT_REMOTE_TIMEOUT_BUFFER_MS),
  });
  if (!response.ok) {
    await readRunnerError(response);
  }

  const initial = sanitizeSnapshot(await parseJobResponse(response), options.secretValues);

  const readRemoteSnapshot = async (
    requestMode: "status" | "wait",
    timeoutMs: number,
  ): Promise<BashJobSnapshot> => {
    const body = requestMode === "wait"
      ? {
        jobId: options.jobId,
        timeoutMs,
      } satisfies BashRunnerJobWaitRequest
      : {
        jobId: options.jobId,
      } satisfies BashRunnerJobQueryRequest;
    const nextResponse = await fetchImpl(buildRunnerEndpoint(runnerUrl, requestMode === "wait" ? "jobs/wait" : "jobs/status"), {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: makeNetworkTimeoutSignal(timeoutMs + DEFAULT_REMOTE_TIMEOUT_BUFFER_MS),
    });
    if (!nextResponse.ok) {
      await readRunnerError(nextResponse);
    }

    return sanitizeSnapshot(await parseJobResponse(nextResponse), options.secretValues);
  };

  const done = (async () => {
    while (true) {
      const snapshot = await readRemoteSnapshot("wait", 60_000);
      if (snapshot.status !== "running") {
        return snapshotToCompletion(snapshot, mode);
      }
    }
  })();

  return {
    startedAt: initial.startedAt,
    result: bashResultPayload(initial, mode),
    progress: snapshotToJobSnapshot(initial, mode).progress ?? undefined,
    snapshot: async () => snapshotToJobSnapshot(await readRemoteSnapshot("status", 15_000), mode),
    done,
    cancel: async () => {
      const cancelResponse = await fetchImpl(buildRunnerEndpoint(runnerUrl, "jobs/cancel"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          jobId: options.jobId,
          timeoutMs: DEFAULT_CANCEL_WAIT_TIMEOUT_MS,
        } satisfies BashRunnerJobCancelRequest),
        signal: makeNetworkTimeoutSignal(DEFAULT_REMOTE_TIMEOUT_BUFFER_MS),
      });
      if (!cancelResponse.ok) {
        await readRunnerError(cancelResponse);
      }

      return snapshotToJobSnapshot(
        sanitizeSnapshot(await parseJobResponse(cancelResponse), options.secretValues),
        mode,
      );
    },
  };
}
