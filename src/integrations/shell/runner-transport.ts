import type {ResolvedExecutionEnvironment} from "../../domain/execution-environments/types.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {trimToNull} from "../../lib/strings.js";
import {
  buildRunnerEndpoint,
  makeNetworkTimeoutSignal,
  resolveRunnerUrl,
} from "../../domain/execution-environments/runner-config.js";
import {
  RUNNER_AGENT_KEY_HEADER,
  RUNNER_AUTHORIZATION_HEADER,
  RUNNER_EXPECTED_PATH_HEADER,
  RUNNER_PATH_SCOPED_HEADER,
} from "./bash-protocol.js";
import {
  loadRunnerTokenAuthority,
  runnerAuthScopeForEnvironment,
  type RunnerAuthScope,
  type RunnerTokenAuthority,
} from "./runner-auth.js";

export interface RunnerTransportTarget {
  agentKey: string;
  runnerUrl: string;
  runnerUrlTemplate: string;
  executionEnvironment?: Pick<ResolvedExecutionEnvironment, "agentKey" | "id" | "kind" | "source">;
  authScope?: RunnerAuthScope;
}

export interface RunnerTransportOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  tokenAuthority?: RunnerTokenAuthority | null;
  legacySharedSecret?: string | null;
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
  authToken?: string | null,
): Record<string, string> {
  const pathScoped = isPathScopedRunnerTemplate(runnerUrlTemplate);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [RUNNER_AGENT_KEY_HEADER]: agentKey,
    [RUNNER_PATH_SCOPED_HEADER]: pathScoped ? "1" : "0",
  };
  if (pathScoped) {
    headers[RUNNER_EXPECTED_PATH_HEADER] = normalizeUrlPathname(new URL(runnerUrl).pathname);
  }
  if (authToken) {
    headers[RUNNER_AUTHORIZATION_HEADER] = `Bearer ${authToken}`;
  }
  return headers;
}

export class RunnerTransport {
  private readonly fetchImpl: typeof fetch;
  private readonly tokenAuthority: RunnerTokenAuthority | null;
  private readonly legacySharedSecret: string | null;

  constructor(options: RunnerTransportOptions = {}) {
    const env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.tokenAuthority = options.tokenAuthority === undefined
      ? loadRunnerTokenAuthority(env)
      : options.tokenAuthority;
    this.legacySharedSecret = options.legacySharedSecret === undefined
      ? trimToNull(env.BASH_SERVER_SHARED_SECRET)
      : trimToNull(options.legacySharedSecret);
  }

  resolveTarget(input: {
    agentKey: string;
    runnerUrlTemplate?: string | null;
    runnerUrl?: string;
    executionEnvironment?: RunnerTransportTarget["executionEnvironment"];
    authScope?: RunnerAuthScope;
  }): RunnerTransportTarget {
    const runnerUrl = input.runnerUrl
      ?? (input.runnerUrlTemplate ? resolveRunnerUrl(input.runnerUrlTemplate, input.agentKey) : null);
    if (!runnerUrl) {
      throw new ToolError("Remote bash execution requires a runner URL.");
    }
    return {
      agentKey: input.agentKey,
      runnerUrl,
      runnerUrlTemplate: input.runnerUrlTemplate ?? runnerUrl,
      ...(input.executionEnvironment ? {executionEnvironment: input.executionEnvironment} : {}),
      ...(input.authScope ? {authScope: input.authScope} : {}),
    };
  }

  headers(target: RunnerTransportTarget): Record<string, string> {
    const scope = target.authScope
      ?? runnerAuthScopeForEnvironment(target.agentKey, target.executionEnvironment);
    const token = this.tokenAuthority?.derive(scope) ?? this.legacySharedSecret;
    return buildRunnerRequestHeaders(
      target.agentKey,
      target.runnerUrlTemplate,
      target.runnerUrl,
      token,
    );
  }

  request(
    target: RunnerTransportTarget,
    endpoint: string,
    options: {body?: unknown; timeoutMs: number; signal?: AbortSignal},
  ): Promise<Response> {
    const timeoutSignal = makeNetworkTimeoutSignal(options.timeoutMs);
    return this.fetchImpl(buildRunnerEndpoint(target.runnerUrl, endpoint), {
      method: "POST",
      headers: this.headers(target),
      ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)}),
      signal: options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal,
    });
  }
}
