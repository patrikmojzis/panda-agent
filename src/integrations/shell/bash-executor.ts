import {randomUUID} from "node:crypto";

import {buildEndpointUrl} from "../../lib/http.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull} from "../../lib/strings.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import {executeBashCommand} from "./bash-execution.js";
import type {
  BashExecutionResult,
  BashRunnerAbortRequest,
  BashRunnerAbortResponse,
  BashRunnerErrorResponse,
  BashRunnerExecRequest,
  BashRunnerResponse,
} from "./bash-protocol.js";
import {RUNNER_AGENT_KEY_HEADER, RUNNER_EXPECTED_PATH_HEADER, RUNNER_PATH_SCOPED_HEADER,} from "./bash-protocol.js";
import {readBashSpawnPreflightFailure} from "./bash-spawn-preflight.js";
import type {ShellExecutionContext} from "./types.js";
import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/index.js";
import {buildShellProcessEnv} from "./environment.js";

const DEFAULT_REMOTE_FETCH_TIMEOUT_BUFFER_MS = 5_000;

export type BashExecutionMode = "local" | "remote";

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
  outputDirectory: string;
  env?: Record<string, string>;
  resolvedEnv?: Record<string, string>;
  shellEnv?: Record<string, string>;
  executionEnvironment?: ResolvedExecutionEnvironment;
  run: RunContext<ShellExecutionContext>;
}

export interface BashExecutor {
  execute<TContext extends ShellExecutionContext>(
    options: BashExecutorOptions & {run: RunContext<TContext>},
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
}

function readAgentKey(context: ShellExecutionContext | undefined): string {
  const agentKey = context?.agentKey;
  if (!agentKey?.trim()) {
    throw new ToolError("Remote bash execution requires agentKey in the current runtime session context.");
  }

  return agentKey;
}

export function resolveBashExecutionMode(env: NodeJS.ProcessEnv = process.env): BashExecutionMode {
  return trimToNull(env.BASH_EXECUTION_MODE) === "remote" ? "remote" : "local";
}

export function resolveRunnerUrlTemplate(env: NodeJS.ProcessEnv = process.env): string | null {
  return trimToNull(env.RUNNER_URL_TEMPLATE);
}

export function resolveRunnerCwdTemplate(env: NodeJS.ProcessEnv = process.env): string | null {
  return trimToNull(env.RUNNER_CWD_TEMPLATE);
}

function resolveAgentTemplateValue(template: string, agentKey: string): string {
  if (!template.includes("{agentKey}")) {
    return template;
  }

  return template.replaceAll("{agentKey}", agentKey);
}

export function resolveRunnerUrl(template: string, agentKey: string): string {
  return resolveAgentTemplateValue(template, agentKey);
}

export function resolveRunnerCwd(template: string, agentKey: string): string {
  return resolveAgentTemplateValue(template, agentKey);
}

export function resolveRemoteInitialCwd(agentKey: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (resolveBashExecutionMode(env) !== "remote") {
    return null;
  }

  const template = resolveRunnerCwdTemplate(env);
  if (!template) {
    return null;
  }

  return resolveRunnerCwd(template, agentKey);
}

function normalizeUrlPathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

function isPathScopedRunnerTemplate(template: string): boolean {
  const marker = "__RUNTIME_AGENT_KEY__";
  const url = new URL(template.replaceAll("{agentKey}", marker));
  return url.pathname.includes(marker);
}

export function buildRunnerRequestHeaders(
  agentKey: string,
  runnerUrlTemplate: string,
  runnerUrl: string,
): Record<string, string> {
  const pathScoped = isPathScopedRunnerTemplate(runnerUrlTemplate);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [RUNNER_AGENT_KEY_HEADER]: agentKey,
    [RUNNER_PATH_SCOPED_HEADER]: pathScoped ? "1" : "0",
  };

  if (pathScoped) {
    // The runner compares this against the request URL so agent-aware routes
    // still fail loudly even when {agentKey} is buried inside a longer path.
    headers[RUNNER_EXPECTED_PATH_HEADER] = normalizeUrlPathname(new URL(runnerUrl).pathname);
  }

  return headers;
}

export function makeNetworkTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new Error(`Remote bash runner did not respond within ${timeoutMs}ms.`));
  }, timeoutMs).unref();
  return controller.signal;
}

export const buildRunnerEndpoint = buildEndpointUrl;

export async function parseRunnerResponse(response: Response): Promise<BashRunnerResponse> {
  const payload = await response.json();
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new ToolError("Remote bash runner returned an invalid response.");
  }

  return payload as unknown as BashRunnerResponse;
}

export async function readRunnerError(response: Response): Promise<never> {
  let payload: BashRunnerErrorResponse | null = null;
  try {
    payload = await parseRunnerResponse(response) as BashRunnerErrorResponse;
  } catch {
    throw new ToolError(`Remote bash runner request failed with status ${response.status}.`);
  }

  if (payload.ok) {
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
    options: BashExecutorOptions & {run: RunContext<TContext>},
  ): Promise<BashExecutionResult> {
    const shell = this.shell ?? this.env.SHELL ?? "/bin/zsh";
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
      onProgress: (progress) => options.run.emitToolProgress(progress),
    });

    if (!outcome.spawnErrorMessage) {
      return outcome.result;
    }

    throw new ToolError(`Failed to spawn shell: ${outcome.spawnErrorMessage}`, {
      details: outcome.spawnErrorDetails,
    });
  }
}

export class RemoteShellExecutor implements BashExecutor {
  private readonly fetchImpl: typeof fetch;
  private readonly runnerUrlTemplate: string | null;

  constructor(options: RemoteShellExecutorOptions = {}) {
    const env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.runnerUrlTemplate = options.runnerUrlTemplate ?? resolveRunnerUrlTemplate(env);
  }

  private async sendAbort(requestId: string, runnerUrl: string, headers: Record<string, string>): Promise<void> {
    const response = await this.fetchImpl(buildRunnerEndpoint(runnerUrl, "abort"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        requestId,
      } satisfies BashRunnerAbortRequest),
      signal: makeNetworkTimeoutSignal(DEFAULT_REMOTE_FETCH_TIMEOUT_BUFFER_MS),
    });

    if (!response.ok) {
      return;
    }

    const payload = await response.json() as BashRunnerAbortResponse;
    if (!payload.ok) {
      return;
    }
  }

  private async sendExecRequest(
    requestId: string,
    runnerUrl: string,
    headers: Record<string, string>,
    options: BashExecutorOptions,
    cwd: string,
  ): Promise<BashExecutionResult> {
    const response = await this.fetchImpl(buildRunnerEndpoint(runnerUrl, "exec"), {
      method: "POST",
      headers,
      body: JSON.stringify({
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
      } satisfies BashRunnerExecRequest),
      signal: makeNetworkTimeoutSignal(options.timeoutMs + DEFAULT_REMOTE_FETCH_TIMEOUT_BUFFER_MS),
    });

    if (!response.ok) {
      await readRunnerError(response);
    }

    const payload = await parseRunnerResponse(response);
    if (!payload.ok) {
      throw new ToolError(payload.error, { details: payload.details });
    }
    if (!("shell" in payload)) {
      throw new ToolError("Remote bash runner returned an invalid foreground response.");
    }

    return payload as BashExecutionResult;
  }

  async execute<TContext extends ShellExecutionContext>(
    options: BashExecutorOptions & {run: RunContext<TContext>},
  ): Promise<BashExecutionResult> {
    if (!this.runnerUrlTemplate && !options.executionEnvironment?.runnerUrl) {
      throw new ToolError("Remote bash execution requires RUNNER_URL_TEMPLATE.");
    }

    const agentKey = readAgentKey(options.run.context);
    const runnerUrl = options.executionEnvironment?.runnerUrl
      ?? resolveRunnerUrl(this.runnerUrlTemplate ?? "", agentKey);
    const runnerUrlTemplate = this.runnerUrlTemplate ?? runnerUrl;
    const headers = buildRunnerRequestHeaders(agentKey, runnerUrlTemplate, runnerUrl);
    let requestId = randomUUID();
    const abortHandler = (): void => {
      void this.sendAbort(requestId, runnerUrl, headers).catch(() => {});
    };

    options.run.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      return await this.sendExecRequest(requestId, runnerUrl, headers, options, options.cwd);
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
