import type {
    DisposableEnvironmentCreateRequest,
    DisposableEnvironmentCreateResult,
    DisposableEnvironmentCommandAccessRefreshRequest,
    DisposableEnvironmentLogEntry,
    DisposableEnvironmentLogsRequest,
    DisposableEnvironmentLogsResult,
    ExecutionEnvironmentManager,
} from "../../domain/execution-environments/types.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {buildEndpointUrl} from "../../lib/http.js";
import {isJsonValue, type JsonValue} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";

const DEFAULT_FETCH_TIMEOUT_MS = 60_000;

export interface HttpExecutionEnvironmentManagerClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  managerUrl?: string;
  sharedSecret?: string;
  timeoutMs?: number;
}

type ManagerResponse = {
  ok: boolean;
  error?: string;
  runnerUrl?: string;
  runnerCwd?: string;
  rootPath?: string;
  metadata?: JsonValue;
  entries?: readonly DisposableEnvironmentLogEntry[];
};

function makeNetworkTimeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(new Error(`Execution environment manager did not respond within ${timeoutMs}ms.`));
  }, timeoutMs).unref();
  return controller.signal;
}

function parseOptionalMetadata(label: string, value: unknown): JsonValue | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isJsonValue(value)) {
    throw new ToolError(`${label} must be JSON-serializable.`);
  }

  return value;
}

function parseManagerResponse(payload: unknown): ManagerResponse {
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new ToolError("Execution environment manager returned an invalid response.");
  }
  return {
    ok: payload.ok,
    error: typeof payload.error === "string" ? payload.error : undefined,
    runnerUrl: trimToUndefined(payload.runnerUrl),
    runnerCwd: trimToUndefined(payload.runnerCwd),
    rootPath: trimToUndefined(payload.rootPath),
    metadata: parseOptionalMetadata("Execution environment manager response metadata", payload.metadata),
    entries: parseOptionalLogEntries(payload.entries),
  };
}

function parseOptionalLogEntries(value: unknown): readonly DisposableEnvironmentLogEntry[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new ToolError("Execution environment manager log response entries must be an array.");
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new ToolError(`Execution environment manager log response entries[${index}] must be an object.`);
    }
    if (entry.role !== "control" && entry.role !== "workspace") {
      throw new ToolError(`Execution environment manager log response entries[${index}].role must be control or workspace.`);
    }
    if (typeof entry.stdout !== "string" || typeof entry.stderr !== "string") {
      throw new ToolError(`Execution environment manager log response entries[${index}] stdout and stderr must be strings.`);
    }

    return {
      role: entry.role,
      stdout: entry.stdout,
      stderr: entry.stderr,
    };
  });
}

async function readManagerError(response: Response): Promise<never> {
  try {
    const payload = parseManagerResponse(await response.json());
    throw new ToolError(payload.ok
      ? `Execution environment manager request failed with status ${response.status}.`
      : payload.error ?? `Execution environment manager request failed with status ${response.status}.`);
  } catch (error) {
    if (error instanceof ToolError) {
      throw error;
    }
    throw new ToolError(`Execution environment manager request failed with status ${response.status}.`);
  }
}

export class HttpExecutionEnvironmentManagerClient implements ExecutionEnvironmentManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchImpl: typeof fetch;
  private readonly managerUrl?: string;
  private readonly sharedSecret?: string;
  private readonly timeoutMs: number;

  constructor(options: HttpExecutionEnvironmentManagerClientOptions = {}) {
    this.env = options.env ?? process.env;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.managerUrl = trimToUndefined(options.managerUrl);
    this.sharedSecret = trimToUndefined(options.sharedSecret);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  async createDisposableEnvironment(
    input: DisposableEnvironmentCreateRequest,
  ): Promise<DisposableEnvironmentCreateResult> {
    const payload = await this.post("environments/disposable", {
      ...input,
      ...(input.metadata === undefined ? {} : {
        metadata: parseOptionalMetadata("Execution environment manager request metadata", input.metadata),
      }),
    });
    if (!payload.runnerUrl || !payload.runnerCwd) {
      throw new ToolError("Execution environment manager returned an invalid create response.");
    }
    return {
      runnerUrl: payload.runnerUrl,
      runnerCwd: payload.runnerCwd,
      ...(payload.rootPath ? {rootPath: payload.rootPath} : {}),
      ...(payload.metadata === undefined ? {} : {metadata: payload.metadata}),
    };
  }

  async stopEnvironment(environmentId: string): Promise<void> {
    await this.post("environments/stop", {environmentId});
  }

  async refreshCommandAccess(input: DisposableEnvironmentCommandAccessRefreshRequest): Promise<void> {
    await this.post("environments/command-access", input);
  }

  async readEnvironmentLogs(input: DisposableEnvironmentLogsRequest): Promise<DisposableEnvironmentLogsResult> {
    const payload = await this.post("environments/logs", input);
    if (!payload.entries) {
      throw new ToolError("Execution environment manager returned an invalid logs response.");
    }
    return {
      entries: payload.entries,
    };
  }

  private resolveConfig(): {managerUrl: string; sharedSecret?: string} {
    const managerUrl = this.managerUrl ?? trimToUndefined(this.env.PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL);
    if (!managerUrl) {
      throw new ToolError("Disposable execution environments require PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL.");
    }

    const sharedSecret = this.sharedSecret ?? trimToUndefined(this.env.PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN);
    return {
      managerUrl,
      ...(sharedSecret ? {sharedSecret} : {}),
    };
  }

  private async post(endpoint: string, body: unknown): Promise<ManagerResponse> {
    const {managerUrl, sharedSecret} = this.resolveConfig();
    const response = await this.fetchImpl(buildEndpointUrl(managerUrl, endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(sharedSecret ? {authorization: `Bearer ${sharedSecret}`} : {}),
      },
      body: JSON.stringify(body),
      signal: makeNetworkTimeoutSignal(this.timeoutMs),
    });

    if (!response.ok) {
      await readManagerError(response);
    }

    const payload = parseManagerResponse(await response.json());
    if (!payload.ok) {
      throw new ToolError(payload.error ?? "Execution environment manager request failed.");
    }
    return payload;
  }
}

export function createExecutionEnvironmentManagerClientFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): HttpExecutionEnvironmentManagerClient | null {
  if (!trimToUndefined(env.PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL)) {
    return null;
  }
  return new HttpExecutionEnvironmentManagerClient({env});
}
