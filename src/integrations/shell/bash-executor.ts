import {randomUUID} from "node:crypto";

import type {JsonObject} from "../../lib/json.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {executeBashCommand} from "./bash-execution.js";
import {sanitizeBashOutputPreview} from "./bash-output.js";
import type {
  BashExecutionResult,
  BashRunnerAbortRequest,
  BashRunnerErrorResponse,
  BashRunnerExecRequest,
  BashRunnerResponse,
} from "./bash-protocol.js";
import {
  parseBashRunnerAbortResponse,
  parseBashRunnerExecResponse,
  parseBashRunnerResponse,
} from "./bash-protocol.js";
import {readBashSpawnPreflightFailure} from "./bash-spawn-preflight.js";
import type {ShellExecutionContext} from "./types.js";
import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";
import {buildShellProcessEnv, SAFE_SHELL} from "./environment.js";
import {redactSecretsInJsonObject} from "./redaction.js";
import {
  assertNoDeprecatedBashServerEnv,
  CORE_BASH_SERVER_ENV_NAMES,
  resolveBashExecutionMode,
  resolveRunnerUrlTemplate,
} from "../../domain/execution-environments/runner-config.js";
import {RunnerTransport} from "./runner-transport.js";
import type {RunnerTokenAuthority} from "./runner-auth.js";

const DEFAULT_REMOTE_FETCH_TIMEOUT_BUFFER_MS = 5_000;

export interface BashExecutorOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  trackedEnvKeys: string[];
  progressIntervalMs: number;
  progressTailChars: number;
  maxOutputChars: number;
  persistOutputThresholdChars: number;
  persistOutputFiles?: boolean;
  redactionValues?: readonly string[];
  outputDirectory: string;
  env?: Record<string, string>;
  resolvedEnv?: Record<string, string>;
  shellEnv?: Record<string, string>;
  executionEnvironment?: ResolvedExecutionEnvironment;
  run: BashExecutionRunContext<ShellExecutionContext>;
}

export interface BashExecutionRunContext<TContext extends ShellExecutionContext = ShellExecutionContext> {
  readonly context?: TContext;
  readonly signal?: AbortSignal;
  emitToolProgress(progress: JsonObject): void;
}

export interface BashExecutor {
  execute<TContext extends ShellExecutionContext>(
    options: BashExecutorOptions & {run: BashExecutionRunContext<TContext>},
  ): Promise<BashExecutionResult>;
}

export interface LocalShellExecutorOptions {
  shell?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RemoteShellExecutorOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  runnerUrlTemplate?: string;
  tokenAuthority?: RunnerTokenAuthority | null;
  legacySharedSecret?: string | null;
  transport?: RunnerTransport;
}

interface BashDiagnosticSanitizationOptions {
  redactionValues?: readonly string[];
}

function sanitizeBashDiagnosticPayload(
  payload: JsonObject,
  options: BashDiagnosticSanitizationOptions,
): JsonObject {
  let sanitized: JsonObject = {...payload};
  if (options.redactionValues && options.redactionValues.length > 0) {
    sanitized = redactSecretsInJsonObject(sanitized, options.redactionValues);
  }

  if (typeof sanitized.stdoutTail === "string") {
    sanitized.stdoutTail = sanitizeBashOutputPreview(sanitized.stdoutTail);
  }
  if (typeof sanitized.stderrTail === "string") {
    sanitized.stderrTail = sanitizeBashOutputPreview(sanitized.stderrTail);
  }

  return sanitized;
}

function readAgentKey(context: ShellExecutionContext | undefined): string {
  const agentKey = context?.agentKey;
  if (!agentKey?.trim()) {
    throw new ToolError("Remote bash execution requires agentKey in the current runtime session context.");
  }

  return agentKey;
}

export async function parseRunnerResponse(response: Response): Promise<BashRunnerResponse> {
  return parseBashRunnerResponse(await response.json());
}

export async function readRunnerError(response: Response): Promise<never> {
  let payload: BashRunnerErrorResponse | null = null;
  try {
    const parsed = await parseRunnerResponse(response);
    if (!parsed.ok) {
      payload = parsed;
    }
  } catch {
    throw new ToolError(`Remote bash runner request failed with status ${response.status}.`);
  }

  if (!payload) {
    throw new ToolError(`Remote bash runner request failed with status ${response.status}.`);
  }

  throw new ToolError(payload.error, { details: payload.details });
}

export class LocalShellExecutor implements BashExecutor {
  private readonly shell?: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: LocalShellExecutorOptions = {}) {
    this.shell = options.shell;
    this.env = options.env ?? process.env;
  }

  async execute<TContext extends ShellExecutionContext>(
    options: BashExecutorOptions & {run: BashExecutionRunContext<TContext>},
  ): Promise<BashExecutionResult> {
    const shell = this.shell ?? this.env.SHELL ?? SAFE_SHELL;
    const spawnFailure = await readBashSpawnPreflightFailure({
      cwd: options.cwd,
      shell,
      scope: "local",
    });
    if (spawnFailure) {
      throw new ToolError(spawnFailure.message, { details: spawnFailure.details });
    }

    const childEnv = buildShellProcessEnv({
      processEnv: this.env,
      executionEnvironment: options.executionEnvironment,
      resolvedEnv: options.resolvedEnv,
      shellEnv: options.shellEnv,
      env: options.env,
    });

    const outcome = await executeBashCommand({
      command: options.command,
      cwd: options.cwd,
      childEnv,
      shell,
      timeoutMs: options.timeoutMs,
      trackedEnvKeys: options.trackedEnvKeys,
      maxOutputChars: options.maxOutputChars,
      persistOutputThresholdChars: options.persistOutputThresholdChars,
      persistOutputFiles: options.persistOutputFiles,
      progressIntervalMs: options.progressIntervalMs,
      progressTailChars: options.progressTailChars,
      outputDirectory: options.outputDirectory,
      signal: options.run.signal,
      onProgress: (progress) => options.run.emitToolProgress(sanitizeBashDiagnosticPayload(progress, options)),
    });

    if (!outcome.spawnErrorMessage) {
      return outcome.result;
    }

    throw new ToolError(`Failed to spawn shell: ${outcome.spawnErrorMessage}`, {
      ...(outcome.spawnErrorDetails
        ? {details: sanitizeBashDiagnosticPayload(outcome.spawnErrorDetails, options)}
        : {}),
    });
  }
}

export class RemoteShellExecutor implements BashExecutor {
  private readonly transport: RunnerTransport;
  private readonly runnerUrlTemplate: string | null;

  constructor(options: RemoteShellExecutorOptions = {}) {
    const env = options.env ?? process.env;
    assertNoDeprecatedBashServerEnv(env, CORE_BASH_SERVER_ENV_NAMES);
    this.runnerUrlTemplate = options.runnerUrlTemplate ?? resolveRunnerUrlTemplate(env);
    this.transport = options.transport ?? new RunnerTransport({
      env,
      fetchImpl: options.fetchImpl,
      tokenAuthority: options.tokenAuthority,
      legacySharedSecret: options.legacySharedSecret,
    });
  }

  private async sendAbort(
    requestId: string,
    target: ReturnType<RunnerTransport["resolveTarget"]>,
  ): Promise<void> {
    const response = await this.transport.request(target, "abort", {
      body: {
        requestId,
      } satisfies BashRunnerAbortRequest,
      timeoutMs: DEFAULT_REMOTE_FETCH_TIMEOUT_BUFFER_MS,
    });

    if (!response.ok) {
      return;
    }

    const payload = parseBashRunnerAbortResponse(await response.json());
    if (!payload.ok) {
      return;
    }
  }

  private async sendExecRequest(
    requestId: string,
    target: ReturnType<RunnerTransport["resolveTarget"]>,
    options: BashExecutorOptions,
    cwd: string,
  ): Promise<BashExecutionResult> {
    const response = await this.transport.request(target, "exec", {
      body: {
        requestId,
        command: options.command,
        cwd,
        timeoutMs: options.timeoutMs,
        trackedEnvKeys: options.trackedEnvKeys,
        maxOutputChars: options.maxOutputChars,
        env: {
          ...(options.resolvedEnv ?? {}),
          ...(options.shellEnv ?? {}),
          ...(options.env ?? {}),
        },
      } satisfies BashRunnerExecRequest,
      timeoutMs: options.timeoutMs + DEFAULT_REMOTE_FETCH_TIMEOUT_BUFFER_MS,
    });

    if (!response.ok) {
      await readRunnerError(response);
    }

    return parseBashRunnerExecResponse(await response.json());
  }

  async execute<TContext extends ShellExecutionContext>(
    options: BashExecutorOptions & {run: BashExecutionRunContext<TContext>},
  ): Promise<BashExecutionResult> {
    if (!this.runnerUrlTemplate && !options.executionEnvironment?.runnerUrl) {
      throw new ToolError("Remote bash execution requires BASH_SERVER_URL_TEMPLATE.");
    }

    const agentKey = readAgentKey(options.run.context);
    const target = this.transport.resolveTarget({
      agentKey,
      runnerUrlTemplate: this.runnerUrlTemplate,
      runnerUrl: options.executionEnvironment?.runnerUrl,
      executionEnvironment: options.executionEnvironment,
    });
    const requestId = randomUUID();
    const abortHandler = (): void => {
      void this.sendAbort(requestId, target).catch(() => {});
    };

    options.run.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      return await this.sendExecRequest(requestId, target, options, options.cwd);
    } catch (error) {
      if (error instanceof ToolError) {
        throw error;
      }

      const message = error instanceof Error ? error.message : "Unknown remote bash runner error.";
      throw new ToolError(`Remote bash runner request failed: ${message}`);
    } finally {
      options.run.signal?.removeEventListener("abort", abortHandler);
    }
  }
}

export function createDefaultBashExecutor(options: {
  shell?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
} = {}): BashExecutor {
  const env = options.env ?? process.env;
  if (resolveBashExecutionMode(env) === "remote") {
    return new RemoteShellExecutor({
      env,
      fetchImpl: options.fetchImpl,
    });
  }

  return new LocalShellExecutor({
    shell: options.shell,
    env,
  });
}
