import {ToolError} from "../../kernel/agent/exceptions.js";
import type {
    BackgroundToolJobCompletion,
    BackgroundToolJobHandle,
    BackgroundToolJobSnapshot,
} from "../../domain/threads/runtime/tool-job-service.js";
import type {JsonObject} from "../../lib/json.js";
import {readRunnerError} from "./bash-executor.js";
import {RunnerTransport, type RunnerTransportTarget} from "./runner-transport.js";
import {ManagedBashJob} from "./bash-background-job.js";
import {buildShellProcessEnv, SAFE_SHELL} from "./environment.js";
import {readBashSpawnPreflightFailure} from "./bash-spawn-preflight.js";
import {
  assertNoDeprecatedBashServerEnv,
  CORE_BASH_SERVER_ENV_NAMES,
  resolveBashExecutionMode,
  resolveRunnerUrlTemplate,
} from "../../domain/execution-environments/runner-config.js";
import type {
    BashJobSnapshot,
    BashRunnerJobCancelRequest,
    BashRunnerJobQueryRequest,
    BashRunnerJobResponse,
    BashRunnerJobStartRequest,
    BashRunnerJobWaitRequest,
} from "./bash-protocol.js";
import {parseBashRunnerJobResponse} from "./bash-protocol.js";
import {redactSecretsInString} from "./redaction.js";
import {sanitizeBashOutputPreview} from "./bash-output.js";
import type {ShellExecutionContext} from "./types.js";
import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";

const DEFAULT_LOCAL_CANCEL_WAIT_TIMEOUT_MS = 1_000;
const DEFAULT_REMOTE_CANCEL_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_REMOTE_TIMEOUT_BUFFER_MS = 5_000;

export interface StartBashBackgroundJobOptions<TContext extends ShellExecutionContext = ShellExecutionContext> {
  jobId: string;
  signal?: AbortSignal;
  command: string;
  cwd: string;
  maxRuntimeMs: number;
  env?: Record<string, string>;
  resolvedEnv?: Record<string, string>;
  shellEnv?: Record<string, string>;
  trackedEnvKeys: string[];
  maxOutputChars: number;
  persistOutputThresholdChars: number;
  outputDirectory: string;
  redactionValues: readonly string[];
  persistOutputFiles: boolean;
  executionEnvironment?: ResolvedExecutionEnvironment;
  context?: TContext;
  processEnv?: NodeJS.ProcessEnv;
  shell?: string;
  fetchImpl?: typeof fetch;
}

function readAgentKey(context: ShellExecutionContext | undefined): string {
  const agentKey = context?.agentKey?.trim();
  if (!agentKey) {
    throw new ToolError("Remote background bash requires agentKey in the current runtime session context.");
  }

  return agentKey;
}

interface SnapshotSanitizationOptions {
  redactionValues: readonly string[];
}

function sanitizeSnapshot(
  snapshot: BashJobSnapshot,
  options: SnapshotSanitizationOptions,
): BashJobSnapshot {
  return {
    ...snapshot,
    command: redactSecretsInString(snapshot.command, options.redactionValues),
    stdout: sanitizeBashOutputPreview(redactSecretsInString(snapshot.stdout, options.redactionValues)),
    stderr: sanitizeBashOutputPreview(redactSecretsInString(snapshot.stderr, options.redactionValues)),
  };
}

function bashResultPayload(snapshot: BashJobSnapshot, mode: "local" | "remote"): JsonObject {
  return {
    jobId: snapshot.jobId,
    status: snapshot.status,
    command: snapshot.command,
    mode,
    initialCwd: snapshot.initialCwd,
    maxRuntimeMs: snapshot.maxRuntimeMs,
    expiresAt: snapshot.expiresAt,
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
    ...(snapshot.timedOut ? {
      error: `Background command exceeded ${snapshot.maxRuntimeMs}ms and its process group was terminated.`,
      statusReason: "Background process maximum runtime expired.",
    } : {}),
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
  try {
    return parseBashRunnerJobResponse(await response.json());
  } catch {
    throw new ToolError("Remote bash runner returned an invalid background job response.");
  }
}

async function compensateAmbiguousRemoteStart(input: {
  transport: RunnerTransport;
  target: RunnerTransportTarget;
  jobId: string;
  error: unknown;
  failureMessage: string;
}): Promise<never> {
  try {
    const response = await input.transport.request(input.target, "jobs/cancel", {
      body: {
        jobId: input.jobId,
        timeoutMs: DEFAULT_REMOTE_CANCEL_WAIT_TIMEOUT_MS,
        reserveIfMissing: true,
      } satisfies BashRunnerJobCancelRequest,
      // The startup signal is already aborted. Compensation needs an independent
      // bounded request or it would be cancelled before reaching the runner.
      timeoutMs: DEFAULT_REMOTE_TIMEOUT_BUFFER_MS,
    });
    if (!response.ok) {
      await readRunnerError(response);
    }
  } catch (compensationError) {
    throw new AggregateError([input.error, compensationError], input.failureMessage);
  }
  throw input.error;
}

export async function startBashBackgroundJob<TContext extends ShellExecutionContext>(
  options: StartBashBackgroundJobOptions<TContext>,
): Promise<BackgroundToolJobHandle> {
  options.signal?.throwIfAborted();
  const processEnv = options.processEnv ?? process.env;
  const shell = options.shell ?? processEnv.SHELL ?? SAFE_SHELL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const mode = options.executionEnvironment?.executionMode ?? resolveBashExecutionMode(processEnv);

  if (mode === "local") {
    const spawnFailure = await readBashSpawnPreflightFailure({
      cwd: options.cwd,
      shell,
      scope: "local",
    });
    if (spawnFailure) {
      throw new ToolError(spawnFailure.message, { details: spawnFailure.details });
    }

    const childEnv = buildShellProcessEnv({
      processEnv,
      executionEnvironment: options.executionEnvironment,
      resolvedEnv: options.resolvedEnv,
      shellEnv: options.shellEnv,
      env: options.env,
    });
    const job = await ManagedBashJob.start({
      jobId: options.jobId,
      command: options.command,
      cwd: options.cwd,
      childEnv,
      shell,
      maxRuntimeMs: options.maxRuntimeMs,
      trackedEnvKeys: options.trackedEnvKeys,
      maxOutputChars: options.maxOutputChars,
      persistOutputThresholdChars: options.persistOutputThresholdChars,
      persistOutputFiles: options.persistOutputFiles,
      outputDirectory: options.outputDirectory,
      signal: options.signal,
    });
    const initial = sanitizeSnapshot(job.snapshot(), options);

    return {
      startedAt: initial.startedAt,
      result: bashResultPayload(initial, mode),
      progress: snapshotToJobSnapshot(initial, mode).progress ?? undefined,
      snapshot: () => snapshotToJobSnapshot(sanitizeSnapshot(job.snapshot(), options), mode),
      done: job.wait(2_147_000_000)
        .then((snapshot) => snapshotToCompletion(sanitizeSnapshot(snapshot, options), mode)),
      cancel: async () => snapshotToJobSnapshot(
        sanitizeSnapshot(await job.cancel(DEFAULT_LOCAL_CANCEL_WAIT_TIMEOUT_MS), options),
        mode,
      ),
    };
  }

  assertNoDeprecatedBashServerEnv(processEnv, CORE_BASH_SERVER_ENV_NAMES);
  const runnerUrlTemplate = resolveRunnerUrlTemplate(processEnv);
  if (!runnerUrlTemplate && !options.executionEnvironment?.runnerUrl) {
    throw new ToolError("Remote background bash requires BASH_SERVER_URL_TEMPLATE.");
  }

  const agentKey = readAgentKey(options.context);
  const transport = new RunnerTransport({env: processEnv, fetchImpl});
  const target = transport.resolveTarget({
    agentKey,
    runnerUrlTemplate,
    runnerUrl: options.executionEnvironment?.runnerUrl,
    executionEnvironment: options.executionEnvironment,
  });
  const request: BashRunnerJobStartRequest = {
    jobId: options.jobId,
    command: options.command,
    cwd: options.cwd,
    maxRuntimeMs: options.maxRuntimeMs,
    trackedEnvKeys: options.trackedEnvKeys,
    maxOutputChars: options.maxOutputChars,
    persistOutputThresholdChars: options.persistOutputThresholdChars,
    persistOutputFiles: options.persistOutputFiles,
    env: Object.keys({
      ...(options.resolvedEnv ?? {}),
      ...(options.shellEnv ?? {}),
      ...(options.env ?? {}),
    }).length > 0
      ? {
        ...(options.resolvedEnv ?? {}),
        ...(options.shellEnv ?? {}),
        ...(options.env ?? {}),
      }
      : undefined,
  };

  let response: Response;
  try {
    response = await transport.request(target, "jobs/start", {
      body: request,
      timeoutMs: DEFAULT_REMOTE_TIMEOUT_BUFFER_MS,
      signal: options.signal,
    });
  } catch (error) {
    return compensateAmbiguousRemoteStart({
      transport, target, jobId: options.jobId, error,
      failureMessage: `Remote background job ${options.jobId} start was ambiguous and compensation failed.`,
    });
  }
  if (!response.ok) {
    try {
      await readRunnerError(response);
    } catch (error) {
      return compensateAmbiguousRemoteStart({
        transport, target, jobId: options.jobId, error,
        failureMessage: `Remote background job ${options.jobId} was rejected ambiguously and compensation failed.`,
      });
    }
  }

  let initial: BashJobSnapshot;
  try {
    initial = sanitizeSnapshot(await parseJobResponse(response), options);
  } catch (error) {
    return compensateAmbiguousRemoteStart({
      transport, target, jobId: options.jobId, error,
      failureMessage: `Remote background job ${options.jobId} returned an ambiguous response and compensation failed.`,
    });
  }

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
    const nextResponse = await transport.request(target, requestMode === "wait" ? "jobs/wait" : "jobs/status", {
      body,
      timeoutMs: timeoutMs + DEFAULT_REMOTE_TIMEOUT_BUFFER_MS,
    });
    if (!nextResponse.ok) {
      await readRunnerError(nextResponse);
    }

    return sanitizeSnapshot(await parseJobResponse(nextResponse), options);
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
      const cancelResponse = await transport.request(target, "jobs/cancel", {
        body: {
          jobId: options.jobId,
          timeoutMs: DEFAULT_REMOTE_CANCEL_WAIT_TIMEOUT_MS,
        } satisfies BashRunnerJobCancelRequest,
        timeoutMs: DEFAULT_REMOTE_TIMEOUT_BUFFER_MS,
      });
      if (!cancelResponse.ok) {
        await readRunnerError(cancelResponse);
      }

      return snapshotToJobSnapshot(
        sanitizeSnapshot(await parseJobResponse(cancelResponse), options),
        mode,
      );
    },
  };
}
