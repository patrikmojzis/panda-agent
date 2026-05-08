import {createHash} from "node:crypto";
import {mkdir} from "node:fs/promises";
import http, {createServer, type IncomingMessage, type Server} from "node:http";
import os from "node:os";
import path from "node:path";

import {normalizeAgentKey} from "../../domain/agents/types.js";
import type {
  DisposableEnvironmentCreateRequest,
  DisposableEnvironmentCreateResult,
  ExecutionEnvironmentManager,
  ExecutionEnvironmentState,
} from "../../domain/execution-environments/index.js";
import {
  DEFAULT_PARENT_RUNNER_ENVIRONMENTS_ROOT,
  DEFAULT_WORKER_ARTIFACTS_PATH,
  DEFAULT_WORKER_INBOX_PATH,
  DEFAULT_WORKER_WORKSPACE_PATH,
  type ExecutionEnvironmentFilesystemMetadata,
} from "../../domain/execution-environments/index.js";
import type {JsonValue} from "../../kernel/agent/types.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {writeJsonResponse} from "../../lib/http.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull, trimToUndefined} from "../../lib/strings.js";

const DEFAULT_MANAGER_HOST = "127.0.0.1";
const DEFAULT_MANAGER_PORT = 8095;
const DEFAULT_DOCKER_HOST = "unix:///var/run/docker.sock";
const DEFAULT_RUNNER_IMAGE = "panda-runner:latest";
const DEFAULT_RUNNER_PORT = 8080;
const DEFAULT_RUNNER_CWD = "/workspace";
const DEFAULT_HOST_BIND_IP = "127.0.0.1";
const DEFAULT_CONTAINER_NAME_PREFIX = "panda-env";
const DEFAULT_CREATE_TIMEOUT_MS = 300_000;
const DEFAULT_DOCKER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CORE_ENVIRONMENTS_ROOT = "/root/.panda/environments";

interface DockerRequestOptions {
  method: string;
  path: string;
  body?: unknown;
  expectedStatuses: readonly number[];
}

interface DockerContainerCreateResult {
  Id: string;
  Warnings?: string[];
}

interface DockerContainerInspectResult {
  Id: string;
  Name?: string;
  Config?: {
    Labels?: Record<string, string>;
  };
  State?: {
    Running?: boolean;
    Status?: string;
    Health?: {
      Status?: string;
    };
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{HostIp?: string; HostPort?: string}> | null>;
  };
}

export interface DockerContainerCreateConfig {
  Image: string;
  Cmd: string[];
  Env: string[];
  WorkingDir: string;
  Labels: Record<string, string>;
  ExposedPorts: Record<string, Record<string, never>>;
  Healthcheck: {
    Test: string[];
    Interval: number;
    Timeout: number;
    Retries: number;
    StartPeriod: number;
  };
  HostConfig: {
    AutoRemove: boolean;
    Init: boolean;
    NetworkMode?: string;
    PortBindings?: Record<string, Array<{HostIp: string; HostPort: string}>>;
    Binds?: string[];
  };
}

export interface DockerClient {
  createContainer(name: string, config: DockerContainerCreateConfig): Promise<DockerContainerCreateResult>;
  startContainer(container: string): Promise<void>;
  inspectContainer(container: string): Promise<DockerContainerInspectResult>;
  stopContainer(container: string): Promise<void>;
  removeContainer(container: string): Promise<void>;
}

export class DockerApiError extends Error {
  readonly statusCode: number;
  readonly details?: JsonValue;

  constructor(message: string, statusCode: number, details?: JsonValue) {
    super(message);
    this.name = "DockerApiError";
    this.statusCode = statusCode;
    this.details = details;
  }
}

class DockerEngineClient implements DockerClient {
  private readonly socketPath?: string;
  private readonly baseUrl?: URL;

  constructor(dockerHost = DEFAULT_DOCKER_HOST) {
    const trimmed = trimToNull(dockerHost) ?? DEFAULT_DOCKER_HOST;
    if (trimmed.startsWith("unix://")) {
      this.socketPath = trimmed.slice("unix://".length);
      return;
    }

    if (trimmed.startsWith("http://")) {
      this.baseUrl = new URL(trimmed);
      return;
    }

    this.socketPath = trimmed;
  }

  async createContainer(name: string, config: DockerContainerCreateConfig): Promise<DockerContainerCreateResult> {
    return this.requestJson<DockerContainerCreateResult>({
      method: "POST",
      path: `/containers/create?name=${encodeURIComponent(name)}`,
      body: config,
      expectedStatuses: [201],
    });
  }

  async startContainer(container: string): Promise<void> {
    await this.requestJson<void>({
      method: "POST",
      path: `/containers/${encodeURIComponent(container)}/start`,
      expectedStatuses: [204, 304],
    });
  }

  async inspectContainer(container: string): Promise<DockerContainerInspectResult> {
    return this.requestJson<DockerContainerInspectResult>({
      method: "GET",
      path: `/containers/${encodeURIComponent(container)}/json`,
      expectedStatuses: [200],
    });
  }

  async stopContainer(container: string): Promise<void> {
    await this.requestJson<void>({
      method: "POST",
      path: `/containers/${encodeURIComponent(container)}/stop?t=3`,
      expectedStatuses: [204, 304, 404],
    });
  }

  async removeContainer(container: string): Promise<void> {
    await this.requestJson<void>({
      method: "DELETE",
      path: `/containers/${encodeURIComponent(container)}?force=1`,
      expectedStatuses: [204, 404],
    });
  }

  private requestJson<T>(options: DockerRequestOptions): Promise<T> {
    return new Promise((resolve, reject) => {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      const requestOptions: http.RequestOptions = this.socketPath
        ? {
          socketPath: this.socketPath,
          method: options.method,
          path: options.path,
        }
        : {
          protocol: this.baseUrl?.protocol,
          hostname: this.baseUrl?.hostname,
          port: this.baseUrl?.port,
          method: options.method,
          path: options.path,
        };

      const request = http.request({
        ...requestOptions,
        headers: {
          ...(body ? {"content-type": "application/json", "content-length": Buffer.byteLength(body)} : {}),
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8").trim();
          const statusCode = response.statusCode ?? 0;
          let payload: unknown;
          if (raw) {
            try {
              payload = JSON.parse(raw) as unknown;
            } catch {
              payload = raw;
            }
          }

          if (!options.expectedStatuses.includes(statusCode)) {
            const message = isRecord(payload) && typeof payload.message === "string"
              ? payload.message
              : `Docker API request failed with status ${statusCode}.`;
            reject(new DockerApiError(message, statusCode, payload as JsonValue));
            return;
          }

          resolve(payload as T);
        });
      });

      request.on("error", reject);
      request.setTimeout(DEFAULT_DOCKER_REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error(`Docker API request ${options.method} ${options.path} timed out.`));
      });
      if (body) {
        request.write(body);
      }
      request.end();
    });
  }
}

export interface DockerExecutionEnvironmentManagerOptions {
  dockerHost?: string;
  dockerClient?: DockerClient;
  image?: string;
  network?: string;
  hostBindIp?: string;
  hostRunnerHost?: string;
  runnerPort?: number;
  runnerCwd?: string;
  hostEnvironmentsRoot?: string;
  managerEnvironmentsRoot?: string;
  coreEnvironmentsRoot?: string;
  parentRunnerEnvironmentsRoot?: string;
  containerNamePrefix?: string;
  createTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

export interface ExecutionEnvironmentManagerServerOptions extends DockerExecutionEnvironmentManagerOptions {
  host?: string;
  port?: number;
  sharedSecret?: string;
  manager?: ExecutionEnvironmentManager;
}

export interface ExecutionEnvironmentManagerServer {
  readonly host: string;
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

function parsePort(value: string | null | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Port must be an integer between 1 and 65535: ${value}`);
  }
  return parsed;
}

function parsePositiveInt(value: string | null | undefined, fallback: number, label: string): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function requireAuthorization(request: IncomingMessage, sharedSecret: string | undefined): void {
  if (!sharedSecret) {
    return;
  }

  const header = trimToNull(request.headers.authorization ?? null);
  if (!header) {
    throw new ToolError("Missing Authorization header.", {details: {statusCode: 401}});
  }
  if (header !== `Bearer ${sharedSecret}`) {
    throw new ToolError("Invalid Authorization header.", {details: {statusCode: 403}});
  }
}

function normalizeDockerNamePart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[_.-]+|[_.-]+$/g, "");
  return cleaned || "env";
}

function resolveDefaultHostEnvironmentsRoot(): string {
  return path.join(os.homedir(), ".panda", "environments");
}

function resolveEnvironmentRootPath(value: string | undefined, fallback: string): string {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return path.resolve(fallback);
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function buildEnvironmentDir(environmentId: string): string {
  const normalized = normalizeDockerNamePart(environmentId);
  const digest = createHash("sha256").update(environmentId).digest("hex").slice(0, 10);
  const maxBaseLength = Math.max(1, 96 - digest.length - 1);
  return `${normalized.slice(0, maxBaseLength)}-${digest}`;
}

function buildContainerName(prefix: string, environmentId: string): string {
  const normalized = normalizeDockerNamePart(environmentId);
  const digest = createHash("sha256").update(environmentId).digest("hex").slice(0, 10);
  const maxBaseLength = Math.max(1, 90 - prefix.length - digest.length - 2);
  return `${prefix}-${normalized.slice(0, maxBaseLength)}-${digest}`;
}

function buildLabels(input: DisposableEnvironmentCreateRequest): Record<string, string> {
  return {
    "panda.managed": "true",
    "panda.environment.id": input.environmentId,
    "panda.agent.key": input.agentKey,
    "panda.session.id": input.sessionId,
    ...(input.ttlMs === undefined ? {} : {"panda.expires_at": new Date(Date.now() + input.ttlMs).toISOString()}),
  };
}

function buildContainerConfig(input: {
  request: DisposableEnvironmentCreateRequest;
  image: string;
  runnerPort: number;
  runnerCwd: string;
  filesystem: ExecutionEnvironmentFilesystemMetadata;
  network?: string;
  hostBindIp: string;
}): DockerContainerCreateConfig {
  const portKey = `${input.runnerPort}/tcp`;
  return {
    Image: input.image,
    Cmd: ["runner"],
    Env: [
      `RUNNER_AGENT_KEY=${input.request.agentKey}`,
      `RUNNER_PORT=${input.runnerPort}`,
      `TZ=${process.env.TZ ?? "UTC"}`,
    ],
    WorkingDir: input.runnerCwd,
    Labels: buildLabels(input.request),
    ExposedPorts: {
      [portKey]: {},
    },
    Healthcheck: {
      Test: ["CMD", "curl", "-fsS", `http://127.0.0.1:${input.runnerPort}/health`],
      Interval: 2_000_000_000,
      Timeout: 1_000_000_000,
      Retries: 30,
      StartPeriod: 1_000_000_000,
    },
    HostConfig: {
      AutoRemove: true,
      Init: true,
      Binds: [
        `${input.filesystem.workspace.hostPath}:${input.filesystem.workspace.workerPath}`,
        `${input.filesystem.inbox.hostPath}:${input.filesystem.inbox.workerPath}`,
        `${input.filesystem.artifacts.hostPath}:${input.filesystem.artifacts.workerPath}`,
      ],
      ...(input.network
        ? {NetworkMode: input.network}
        : {
          PortBindings: {
            [portKey]: [
              {
                HostIp: input.hostBindIp,
                HostPort: "",
              },
            ],
          },
        }),
    },
  };
}

function buildFilesystemMetadata(input: {
  agentKey: string;
  environmentId: string;
  hostRoot: string;
  managerRoot: string;
  coreRoot: string;
  parentRunnerRoot: string;
}): ExecutionEnvironmentFilesystemMetadata {
  const envDir = buildEnvironmentDir(input.environmentId);
  const root = {
    hostPath: path.join(input.hostRoot, input.agentKey, envDir),
    managerPath: path.join(input.managerRoot, input.agentKey, envDir),
    corePath: path.join(input.coreRoot, input.agentKey, envDir),
    parentRunnerPath: path.posix.join(input.parentRunnerRoot, envDir),
  };
  return {
    envDir,
    root,
    workspace: {
      hostPath: path.join(root.hostPath, "workspace"),
      managerPath: path.join(root.managerPath, "workspace"),
      corePath: path.join(root.corePath, "workspace"),
      parentRunnerPath: path.posix.join(root.parentRunnerPath, "workspace"),
      workerPath: DEFAULT_WORKER_WORKSPACE_PATH,
    },
    inbox: {
      hostPath: path.join(root.hostPath, "inbox"),
      managerPath: path.join(root.managerPath, "inbox"),
      corePath: path.join(root.corePath, "inbox"),
      parentRunnerPath: path.posix.join(root.parentRunnerPath, "inbox"),
      workerPath: DEFAULT_WORKER_INBOX_PATH,
    },
    artifacts: {
      hostPath: path.join(root.hostPath, "artifacts"),
      managerPath: path.join(root.managerPath, "artifacts"),
      corePath: path.join(root.corePath, "artifacts"),
      parentRunnerPath: path.posix.join(root.parentRunnerPath, "artifacts"),
      workerPath: DEFAULT_WORKER_ARTIFACTS_PATH,
    },
  };
}

async function ensureEnvironmentFilesystem(
  filesystem: ExecutionEnvironmentFilesystemMetadata,
): Promise<void> {
  await Promise.all([
    mkdir(filesystem.workspace.managerPath ?? filesystem.workspace.hostPath ?? filesystem.workspace.corePath, {recursive: true}),
    mkdir(filesystem.inbox.managerPath ?? filesystem.inbox.hostPath ?? filesystem.inbox.corePath, {recursive: true}),
    mkdir(filesystem.artifacts.managerPath ?? filesystem.artifacts.hostPath ?? filesystem.artifacts.corePath, {recursive: true}),
  ]);
}

function readPublishedPort(inspect: DockerContainerInspectResult, runnerPort: number): string {
  const portKey = `${runnerPort}/tcp`;
  const binding = inspect.NetworkSettings?.Ports?.[portKey]?.[0];
  const hostPort = trimToUndefined(binding?.HostPort);
  if (!hostPort) {
    throw new Error(`Disposable runner container is missing published port ${portKey}.`);
  }
  return hostPort;
}

function inspectToState(inspect: DockerContainerInspectResult): ExecutionEnvironmentState {
  if (!inspect.State?.Running) {
    return "stopped";
  }

  const health = inspect.State.Health?.Status;
  if (health === "healthy") {
    return "ready";
  }
  if (health === "starting") {
    return "provisioning";
  }
  if (health === "unhealthy") {
    return "failed";
  }

  return "ready";
}

function isExpectedManagedEnvironment(
  inspect: DockerContainerInspectResult,
  expectedLabels: Pick<DisposableEnvironmentCreateRequest, "agentKey" | "environmentId" | "sessionId">,
): boolean {
  const labels = inspect.Config?.Labels;
  return labels?.["panda.managed"] === "true"
    && labels["panda.environment.id"] === expectedLabels.environmentId
    && labels["panda.agent.key"] === expectedLabels.agentKey
    && labels["panda.session.id"] === expectedLabels.sessionId;
}

function isManagedEnvironmentId(
  inspect: DockerContainerInspectResult,
  environmentId: string,
): boolean {
  const labels = inspect.Config?.Labels;
  return labels?.["panda.managed"] === "true"
    && labels["panda.environment.id"] === environmentId;
}

function isAutoRemoveInProgress(error: unknown): boolean {
  return error instanceof DockerApiError
    && error.statusCode === 409
    && /removal of container .* is already in progress/i.test(error.message);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(`Environment manager request body must be valid JSON: ${message}`);
  }
}

function validateCreateRequest(value: unknown): DisposableEnvironmentCreateRequest {
  if (!isRecord(value)) {
    throw new ToolError("Create disposable environment request must be an object.");
  }

  const agentKey = normalizeAgentKey(trimToNull(value.agentKey) ?? "");
  const sessionId = trimToNull(value.sessionId);
  const environmentId = trimToNull(value.environmentId);
  const ttlMs = value.ttlMs === undefined ? undefined : Number(value.ttlMs);
  if (!sessionId) {
    throw new ToolError("sessionId must not be empty.");
  }
  if (!environmentId) {
    throw new ToolError("environmentId must not be empty.");
  }
  if (ttlMs !== undefined && (!Number.isInteger(ttlMs) || ttlMs < 1)) {
    throw new ToolError("ttlMs must be a positive integer.");
  }

  return {
    agentKey,
    sessionId,
    environmentId,
    ...(ttlMs === undefined ? {} : {ttlMs}),
    ...(value.metadata === undefined ? {} : {metadata: value.metadata as JsonValue}),
  };
}

function validateEnvironmentIdRequest(value: unknown): {environmentId: string} {
  if (!isRecord(value)) {
    throw new ToolError("Environment request body must be an object.");
  }

  const environmentId = trimToNull(value.environmentId);
  if (!environmentId) {
    throw new ToolError("environmentId must not be empty.");
  }
  return {environmentId};
}

export function resolveDockerExecutionEnvironmentManagerOptions(
  env: NodeJS.ProcessEnv = process.env,
): DockerExecutionEnvironmentManagerOptions {
  return {
    env,
    dockerHost: trimToUndefined(env.PANDA_DOCKER_HOST) ?? trimToUndefined(env.DOCKER_HOST) ?? DEFAULT_DOCKER_HOST,
    image: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_IMAGE) ?? DEFAULT_RUNNER_IMAGE,
    network: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_NETWORK),
    hostBindIp: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_HOST_BIND_IP) ?? DEFAULT_HOST_BIND_IP,
    hostRunnerHost: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_PUBLIC_HOST) ?? DEFAULT_HOST_BIND_IP,
    runnerPort: parsePort(trimToNull(env.PANDA_DISPOSABLE_RUNNER_PORT), DEFAULT_RUNNER_PORT),
    runnerCwd: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_CWD) ?? DEFAULT_RUNNER_CWD,
    hostEnvironmentsRoot: resolveEnvironmentRootPath(
      env.PANDA_ENVIRONMENTS_HOST_ROOT,
      resolveDefaultHostEnvironmentsRoot(),
    ),
    managerEnvironmentsRoot: resolveEnvironmentRootPath(
      env.PANDA_ENVIRONMENTS_ROOT,
      trimToUndefined(env.PANDA_ENVIRONMENTS_HOST_ROOT) ?? resolveDefaultHostEnvironmentsRoot(),
    ),
    coreEnvironmentsRoot: resolveEnvironmentRootPath(
      env.PANDA_CORE_ENVIRONMENTS_ROOT ?? env.PANDA_ENVIRONMENTS_ROOT,
      DEFAULT_CORE_ENVIRONMENTS_ROOT,
    ),
    parentRunnerEnvironmentsRoot: trimToUndefined(env.PANDA_RUNNER_ENVIRONMENTS_ROOT)
      ?? DEFAULT_PARENT_RUNNER_ENVIRONMENTS_ROOT,
    containerNamePrefix: trimToUndefined(env.PANDA_DISPOSABLE_CONTAINER_PREFIX) ?? DEFAULT_CONTAINER_NAME_PREFIX,
    createTimeoutMs: parsePositiveInt(
      trimToNull(env.PANDA_DISPOSABLE_CREATE_TIMEOUT_MS),
      DEFAULT_CREATE_TIMEOUT_MS,
      "PANDA_DISPOSABLE_CREATE_TIMEOUT_MS",
    ),
  };
}

export function resolveExecutionEnvironmentManagerServerOptions(
  env: NodeJS.ProcessEnv = process.env,
): ExecutionEnvironmentManagerServerOptions {
  const host = trimToUndefined(env.PANDA_EXECUTION_ENVIRONMENT_MANAGER_HOST) ?? DEFAULT_MANAGER_HOST;
  const sharedSecret = trimToUndefined(env.PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN);
  if (!isLoopbackBindHost(host) && !sharedSecret) {
    throw new Error("PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN is required when the environment manager binds outside loopback.");
  }

  return {
    ...resolveDockerExecutionEnvironmentManagerOptions(env),
    host,
    port: parsePort(trimToNull(env.PANDA_EXECUTION_ENVIRONMENT_MANAGER_PORT), DEFAULT_MANAGER_PORT),
    sharedSecret,
  };
}

export class DockerExecutionEnvironmentManager implements ExecutionEnvironmentManager {
  private readonly docker: DockerClient;
  private readonly image: string;
  private readonly network?: string;
  private readonly hostBindIp: string;
  private readonly hostRunnerHost: string;
  private readonly runnerPort: number;
  private readonly runnerCwd: string;
  private readonly hostEnvironmentsRoot: string;
  private readonly managerEnvironmentsRoot: string;
  private readonly coreEnvironmentsRoot: string;
  private readonly parentRunnerEnvironmentsRoot: string;
  private readonly containerNamePrefix: string;
  private readonly createTimeoutMs: number;

  constructor(options: DockerExecutionEnvironmentManagerOptions = {}) {
    const resolved = {
      ...resolveDockerExecutionEnvironmentManagerOptions(options.env),
      ...options,
    };
    this.docker = resolved.dockerClient ?? new DockerEngineClient(resolved.dockerHost);
    this.image = resolved.image ?? DEFAULT_RUNNER_IMAGE;
    this.network = trimToUndefined(resolved.network);
    this.hostBindIp = resolved.hostBindIp ?? DEFAULT_HOST_BIND_IP;
    this.hostRunnerHost = resolved.hostRunnerHost ?? DEFAULT_HOST_BIND_IP;
    this.runnerPort = resolved.runnerPort ?? DEFAULT_RUNNER_PORT;
    this.runnerCwd = resolved.runnerCwd ?? DEFAULT_RUNNER_CWD;
    this.hostEnvironmentsRoot = resolveEnvironmentRootPath(
      resolved.hostEnvironmentsRoot,
      resolveDefaultHostEnvironmentsRoot(),
    );
    this.managerEnvironmentsRoot = resolveEnvironmentRootPath(
      resolved.managerEnvironmentsRoot,
      this.hostEnvironmentsRoot,
    );
    this.coreEnvironmentsRoot = resolveEnvironmentRootPath(
      resolved.coreEnvironmentsRoot,
      DEFAULT_CORE_ENVIRONMENTS_ROOT,
    );
    this.parentRunnerEnvironmentsRoot = trimToUndefined(resolved.parentRunnerEnvironmentsRoot)
      ?? DEFAULT_PARENT_RUNNER_ENVIRONMENTS_ROOT;
    this.containerNamePrefix = resolved.containerNamePrefix ?? DEFAULT_CONTAINER_NAME_PREFIX;
    this.createTimeoutMs = resolved.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS;
  }

  async createDisposableEnvironment(
    input: DisposableEnvironmentCreateRequest,
  ): Promise<DisposableEnvironmentCreateResult> {
    const request = {
      ...input,
      agentKey: normalizeAgentKey(input.agentKey),
      environmentId: trimToNull(input.environmentId) ?? "",
      sessionId: trimToNull(input.sessionId) ?? "",
    };
    if (!request.environmentId || !request.sessionId) {
      throw new Error("Disposable environment requests require environmentId and sessionId.");
    }

    const containerName = buildContainerName(this.containerNamePrefix, request.environmentId);
    const filesystem = buildFilesystemMetadata({
      agentKey: request.agentKey,
      environmentId: request.environmentId,
      hostRoot: this.hostEnvironmentsRoot,
      managerRoot: this.managerEnvironmentsRoot,
      coreRoot: this.coreEnvironmentsRoot,
      parentRunnerRoot: this.parentRunnerEnvironmentsRoot,
    });
    await ensureEnvironmentFilesystem(filesystem);
    const config = buildContainerConfig({
      request,
      image: this.image,
      runnerPort: this.runnerPort,
      runnerCwd: this.runnerCwd,
      filesystem,
      network: this.network,
      hostBindIp: this.hostBindIp,
    });
    const containerId = await this.ensureContainer(containerName, request, config);
    let inspect: DockerContainerInspectResult;
    try {
      await this.docker.startContainer(containerId);
      inspect = await this.waitForReady(containerName);
    } catch (error) {
      await this.cleanupFailedCreate(containerName);
      throw error;
    }

    const runnerUrl = this.network
      ? `http://${containerName}:${this.runnerPort}`
      : `http://${this.hostRunnerHost}:${readPublishedPort(inspect, this.runnerPort)}`;
    return {
      runnerUrl,
      runnerCwd: this.runnerCwd,
      rootPath: this.runnerCwd,
      metadata: {
        filesystem: filesystem as unknown as JsonValue,
        containerId: inspect.Id || containerId,
        containerName,
        image: this.image,
        ...(this.network ? {network: this.network} : {}),
      } as JsonValue,
    };
  }

  async stopEnvironment(environmentId: string): Promise<void> {
    const containerName = buildContainerName(this.containerNamePrefix, environmentId);
    const inspect = await this.inspectManagedContainer(containerName, environmentId);
    if (!inspect) {
      return;
    }
    await this.docker.stopContainer(containerName);
    try {
      await this.docker.removeContainer(containerName);
    } catch (error) {
      if (isAutoRemoveInProgress(error)) {
        return;
      }
      throw error;
    }
  }

  private async cleanupFailedCreate(container: string): Promise<void> {
    try {
      await this.docker.stopContainer(container);
    } catch {
      // Best effort. A failed start may leave nothing to stop.
    }
    try {
      await this.docker.removeContainer(container);
    } catch (error) {
      if (isAutoRemoveInProgress(error)) {
        return;
      }
    }
  }

  private async ensureContainer(
    containerName: string,
    request: DisposableEnvironmentCreateRequest,
    config: DockerContainerCreateConfig,
  ): Promise<string> {
    try {
      const created = await this.docker.createContainer(containerName, config);
      return created.Id;
    } catch (error) {
      if (!(error instanceof DockerApiError) || error.statusCode !== 409) {
        throw error;
      }

      const existing = await this.docker.inspectContainer(containerName);
      if (!isExpectedManagedEnvironment(existing, request)) {
        throw error;
      }
      return existing.Id;
    }
  }

  private async inspectManagedContainer(
    containerName: string,
    environmentId: string,
  ): Promise<DockerContainerInspectResult | null> {
    let inspect: DockerContainerInspectResult;
    try {
      inspect = await this.docker.inspectContainer(containerName);
    } catch (error) {
      if (error instanceof DockerApiError && error.statusCode === 404) {
        return null;
      }
      throw error;
    }

    if (!isManagedEnvironmentId(inspect, environmentId)) {
      throw new Error(`Refusing to stop non-Panda or mismatched container ${containerName}.`);
    }
    return inspect;
  }

  private async waitForReady(container: string): Promise<DockerContainerInspectResult> {
    const startedAt = Date.now();
    let lastState: ExecutionEnvironmentState = "provisioning";
    while (Date.now() - startedAt < this.createTimeoutMs) {
      const inspect = await this.docker.inspectContainer(container);
      const state = inspectToState(inspect);
      if (state === "ready") {
        return inspect;
      }
      if (state === "failed" || state === "stopped") {
        throw new Error(`Disposable environment container ${container} is ${state}.`);
      }

      lastState = state;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    throw new Error(`Timed out waiting for disposable environment container ${container}; last state ${lastState}.`);
  }
}

export async function startExecutionEnvironmentManager(
  options: ExecutionEnvironmentManagerServerOptions = {},
): Promise<ExecutionEnvironmentManagerServer> {
  const host = options.host ?? DEFAULT_MANAGER_HOST;
  const port = options.port ?? DEFAULT_MANAGER_PORT;
  const sharedSecret = trimToUndefined(options.sharedSecret);
  if (!isLoopbackBindHost(host) && !sharedSecret) {
    throw new Error("PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN is required when the environment manager binds outside loopback.");
  }

  const manager = options.manager ?? new DockerExecutionEnvironmentManager(options);
  const server = createServer(async (request, response) => {
    try {
      if (!request.url) {
        response.statusCode = 404;
        response.end();
        return;
      }

      const requestUrl = new URL(request.url, `http://${request.headers.host ?? "environment-manager.local"}`);
      if (request.method === "GET" && requestUrl.pathname === "/health") {
        writeJsonResponse(response, 200, {ok: true});
        return;
      }

      if (request.method !== "POST") {
        response.statusCode = 404;
        response.end();
        return;
      }

      requireAuthorization(request, sharedSecret);
      const body = await readJsonBody(request);
      if (requestUrl.pathname === "/environments/disposable") {
        const result = await manager.createDisposableEnvironment(validateCreateRequest(body));
        writeJsonResponse(response, 200, {
          ok: true,
          ...result,
        });
        return;
      }

      if (requestUrl.pathname === "/environments/stop") {
        const parsed = validateEnvironmentIdRequest(body);
        await manager.stopEnvironment(parsed.environmentId);
        writeJsonResponse(response, 200, {ok: true});
        return;
      }

      response.statusCode = 404;
      response.end();
    } catch (error) {
      if (error instanceof ToolError) {
        const statusCode = isRecord(error.details) && typeof error.details.statusCode === "number"
          ? error.details.statusCode
          : 400;
        writeJsonResponse(response, statusCode, {
          ok: false,
          error: error.message,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      writeJsonResponse(response, 500, {
        ok: false,
        error: message,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  return {
    host,
    port: address && typeof address === "object" ? address.port : port,
    server,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }).catch(() => undefined);
    },
  };
}
