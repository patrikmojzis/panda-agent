import {createHash, createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import {mkdir} from "node:fs/promises";
import http, {createServer, type IncomingMessage, type Server} from "node:http";
import type {Readable} from "node:stream";
import os from "node:os";
import path from "node:path";

import {normalizeAgentKey} from "../../domain/agents/types.js";
import type {
  DisposableEnvironmentCreateRequest,
  DisposableEnvironmentCreateResult,
  ExecutionEnvironmentManager,
  ExecutionEnvironmentNetworkPolicy,
  ExecutionEnvironmentState,
} from "../../domain/execution-environments/types.js";
import {normalizeExecutionEnvironmentNetworkPolicy} from "../../domain/execution-environments/types.js";
import {
  DEFAULT_PARENT_RUNNER_ENVIRONMENTS_ROOT,
  DEFAULT_WORKER_ARTIFACTS_PATH,
  DEFAULT_WORKER_INBOX_PATH,
  DEFAULT_WORKER_WORKSPACE_PATH,
  type ExecutionEnvironmentFilesystemMetadata,
} from "../../domain/execution-environments/filesystem.js";
import {sleep} from "../../lib/async.js";
import {isJsonValue, type JsonValue} from "../../lib/json.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {isLoopbackHttpHostname, writeJsonResponse} from "../../lib/http.js";
import {readTcpPort} from "../../lib/numbers.js";
import {isRecord} from "../../lib/records.js";
import {trimToNull, trimToUndefined} from "../../lib/strings.js";
import {readJsonHttpBody} from "../http-body.js";
import {buildSafeCommandBaseEnv} from "./environment.js";
import {appendOutput, createOutputCapture, finalizeOutputCapture} from "./bash-output.js";
import type {WorkspaceExecAction, WorkspaceExecStartRequest, WorkspaceProcessSnapshot} from "./workspace-exec-protocol.js";
import {assertNoDeprecatedBashServerEnv, DOCKER_MANAGER_BASH_SERVER_ENV_NAMES} from "./bash-server-env.js";

const DEFAULT_MANAGER_HOST = "127.0.0.1";
const DEFAULT_MANAGER_PORT = 8095;
const DEFAULT_DOCKER_HOST = "unix:///var/run/docker.sock";
const DEFAULT_CONTROL_RUNNER_IMAGE = "panda-runner:latest";
const DEFAULT_WORKSPACE_IMAGE = "panda-workspace:latest";
const DEFAULT_RUNNER_PORT = 8080;
const DEFAULT_RUNNER_CWD = "/workspace";
const DEFAULT_HOST_BIND_IP = "127.0.0.1";
const DEFAULT_CONTAINER_NAME_PREFIX = "panda-env";
const DEFAULT_CREATE_TIMEOUT_MS = 300_000;
const DEFAULT_DOCKER_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CORE_ENVIRONMENTS_ROOT = "/root/.panda/environments";
const DOCKER_DNS_LABEL_MAX_LENGTH = 63;
const MAX_ENVIRONMENT_MANAGER_JSON_BODY_BYTES = 8 * 1024 * 1024;
const DOCKER_EXEC_COMPLETION_WAIT_MS = 2_000;
const DOCKER_EXEC_COMPLETION_POLL_MS = 25;

interface DockerRequestOptions {
  method: string;
  path: string;
  body?: unknown;
  expectedStatuses: readonly number[];
}

interface DockerStreamRequestOptions extends DockerRequestOptions {
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
  HostConfig?: {
    NetworkMode?: string;
  };
  NetworkSettings?: {
    Ports?: Record<string, Array<{HostIp?: string; HostPort?: string}> | null>;
  };
}

export interface DockerNetworkInspectResult {
  Name?: string;
  Internal?: boolean;
}

export interface DockerExecCreateConfig {
  AttachStdout: true;
  AttachStderr: true;
  AttachStdin?: false;
  Tty: false;
  Cmd: string[];
  WorkingDir: string;
  Env: string[];
}

interface DockerExecCreateResult {
  Id: string;
}

interface DockerExecInspectResult {
  ID?: string;
  Running?: boolean;
  ExitCode?: number | null;
}

export interface DockerContainerCreateConfig {
  Image: string;
  Cmd: string[];
  Env: string[];
  WorkingDir: string;
  Labels: Record<string, string>;
  ExposedPorts?: Record<string, Record<string, never>>;
  Healthcheck?: {
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
  inspectNetwork(network: string): Promise<DockerNetworkInspectResult>;
  createExec(container: string, config: DockerExecCreateConfig): Promise<DockerExecCreateResult>;
  startExec(execId: string, options: {Detach: false; Tty: false}): Promise<Readable>;
  inspectExec(execId: string): Promise<DockerExecInspectResult>;
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

  async inspectNetwork(network: string): Promise<DockerNetworkInspectResult> {
    return this.requestJson<DockerNetworkInspectResult>({
      method: "GET",
      path: `/networks/${encodeURIComponent(network)}`,
      expectedStatuses: [200],
    });
  }

  async createExec(container: string, config: DockerExecCreateConfig): Promise<DockerExecCreateResult> {
    return this.requestJson<DockerExecCreateResult>({
      method: "POST",
      path: `/containers/${encodeURIComponent(container)}/exec`,
      body: config,
      expectedStatuses: [201],
    });
  }

  async startExec(execId: string, options: {Detach: false; Tty: false}): Promise<Readable> {
    return this.requestStream({
      method: "POST",
      path: `/exec/${encodeURIComponent(execId)}/start`,
      body: options,
      expectedStatuses: [200],
    });
  }

  async inspectExec(execId: string): Promise<DockerExecInspectResult> {
    return this.requestJson<DockerExecInspectResult>({
      method: "GET",
      path: `/exec/${encodeURIComponent(execId)}/json`,
      expectedStatuses: [200],
    });
  }

  private requestStream(options: DockerStreamRequestOptions): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      const requestOptions: http.RequestOptions = this.socketPath
        ? {socketPath: this.socketPath, method: options.method, path: options.path}
        : {protocol: this.baseUrl?.protocol, hostname: this.baseUrl?.hostname, port: this.baseUrl?.port, method: options.method, path: options.path};
      const request = http.request({
        ...requestOptions,
        headers: {...(body ? {"content-type": "application/json", "content-length": Buffer.byteLength(body)} : {})},
      }, (response) => {
        const statusCode = response.statusCode ?? 0;
        if (!options.expectedStatuses.includes(statusCode)) {
          const chunks: Buffer[] = [];
          response.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
          response.on("end", () => reject(new DockerApiError(`Docker API stream request failed with status ${statusCode}.`, statusCode, Buffer.concat(chunks).toString("utf8"))));
          return;
        }
        resolve(response);
      });
      request.on("error", reject);
      request.setTimeout(DEFAULT_DOCKER_REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error(`Docker API request ${options.method} ${options.path} timed out.`));
      });
      if (body) request.write(body);
      request.end();
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
  controlRunnerImage?: string;
  workspaceImage?: string;
  workspaceExecSecret?: string;
  managerUrl?: string;
  network?: string;
  localOnlyNetwork?: string;
  hostBindIp?: string;
  hostRunnerHost?: string;
  runnerPort?: number;
  runnerCwd?: string;
  runnerSharedSecret?: string;
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

  const parsed = readTcpPort(value);
  if (parsed === undefined) {
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


export interface WorkspaceExecCredentialPayload {
  readonly capability: "workspace-exec";
  readonly environmentId: string;
}

export interface WorkspaceExecCredentialValidator {
  validateWorkspaceExecCredential(environmentId: string, credential: string): boolean;
}

interface WorkspaceExecActionHandler {
  handleWorkspaceExecAction(action: WorkspaceExecAction): Promise<WorkspaceProcessSnapshot>;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function signWorkspaceExecPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", secret).update(encodedPayload).digest("base64url");
}

export function createWorkspaceExecCredential(input: {
  environmentId: string;
  secret: string;
}): string {
  const payload: WorkspaceExecCredentialPayload = {
    capability: "workspace-exec",
    environmentId: input.environmentId,
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = signWorkspaceExecPayload(encodedPayload, input.secret);
  return `panda-workspace-exec-v1.${encodedPayload}.${signature}`;
}

export function validateWorkspaceExecCredential(input: {
  environmentId: string;
  credential: string;
  secret: string;
}): boolean {
  const parts = input.credential.split(".");
  if (parts.length !== 3 || parts[0] !== "panda-workspace-exec-v1") {
    return false;
  }
  const [, encodedPayload, signature] = parts;
  if (!encodedPayload || !signature) {
    return false;
  }
  const expectedSignature = signWorkspaceExecPayload(encodedPayload, input.secret);
  const signatureBuffer = Buffer.from(signature, "base64url");
  const expectedBuffer = Buffer.from(expectedSignature, "base64url");
  if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
    return false;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  return isRecord(payload)
    && payload.capability === "workspace-exec"
    && payload.environmentId === input.environmentId;
}

function requireWorkspaceExecAuthorization(
  request: IncomingMessage,
  environmentId: string,
  validator: WorkspaceExecCredentialValidator,
): void {
  const header = trimToNull(request.headers.authorization ?? null);
  if (!header) {
    throw new ToolError("Missing Authorization header.", {details: {statusCode: 401}});
  }
  const credential = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  if (!credential || !validator.validateWorkspaceExecCredential(environmentId, credential)) {
    throw new ToolError("Invalid workspace exec credential.", {details: {statusCode: 403}});
  }
}

function hasWorkspaceExecCredentialValidator(value: ExecutionEnvironmentManager): value is ExecutionEnvironmentManager & WorkspaceExecCredentialValidator {
  return typeof (value as {validateWorkspaceExecCredential?: unknown}).validateWorkspaceExecCredential === "function";
}

function hasWorkspaceExecActionHandler(value: ExecutionEnvironmentManager): value is ExecutionEnvironmentManager & WorkspaceExecCredentialValidator & WorkspaceExecActionHandler {
  return hasWorkspaceExecCredentialValidator(value)
    && typeof (value as {handleWorkspaceExecAction?: unknown}).handleWorkspaceExecAction === "function";
}

function normalizeDockerNamePart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^[_.-]+|[_.-]+$/g, "");
  return cleaned || "env";
}

function normalizeDockerDnsLabelPart(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "env";
}

function trimDockerDnsPart(value: string, maxLength: number): string {
  return value.slice(0, Math.max(1, maxLength)).replace(/-+$/g, "") || "env";
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

function buildContainerName(prefix: string, environmentId: string, role?: "control" | "workspace"): string {
  const normalizedPrefix = normalizeDockerDnsLabelPart(prefix);
  const normalized = normalizeDockerDnsLabelPart(environmentId);
  const digest = createHash("sha256").update(environmentId).digest("hex").slice(0, 10);
  const rolePart = role ? `-${role}` : "";
  const maxPrefixLength = DOCKER_DNS_LABEL_MAX_LENGTH - digest.length - rolePart.length - 3;
  const trimmedPrefix = trimDockerDnsPart(normalizedPrefix, maxPrefixLength);
  const maxBaseLength = DOCKER_DNS_LABEL_MAX_LENGTH - trimmedPrefix.length - digest.length - rolePart.length - 2;
  const trimmedBase = trimDockerDnsPart(normalized, maxBaseLength);
  return `${trimmedPrefix}-${trimmedBase}${rolePart}-${digest}`;
}

function buildLabels(input: DisposableEnvironmentCreateRequest, role?: "control" | "workspace", extra: Record<string, string> = {}): Record<string, string> {
  return {
    "panda.managed": "true",
    "panda.environment.id": input.environmentId,
    "panda.agent.key": input.agentKey,
    "panda.session.id": input.sessionId,
    "panda.environment.network_policy": normalizeExecutionEnvironmentNetworkPolicy(input.networkPolicy),
    ...(role ? {"panda.environment.role": role} : {}),
    ...(input.ttlMs === undefined ? {} : {"panda.expires_at": new Date(Date.now() + input.ttlMs).toISOString()}),
    ...extra,
  };
}

function buildControlContainerConfig(input: {
  request: DisposableEnvironmentCreateRequest;
  image: string;
  runnerPort: number;
  runnerCwd: string;
  runnerSharedSecret?: string;
  workspaceExecToken: string;
  managerUrl?: string;
  workspaceContainerName: string;
  filesystem: ExecutionEnvironmentFilesystemMetadata;
  network?: string;
  hostBindIp: string;
}): DockerContainerCreateConfig {
  const portKey = `${input.runnerPort}/tcp`;
  const safeEnv = buildSafeCommandBaseEnv({TZ: process.env.TZ ?? "UTC"});
  return {
    Image: input.image,
    Cmd: ["bash-server"],
    Env: [
      `PATH=${safeEnv.PATH ?? ""}`,
      `SHELL=${safeEnv.SHELL ?? ""}`,
      `HOME=${safeEnv.HOME ?? ""}`,
      `TMPDIR=${safeEnv.TMPDIR ?? ""}`,
      `LANG=${safeEnv.LANG ?? ""}`,
      `BASH_SERVER_AGENT_KEY=${input.request.agentKey}`,
      `BASH_SERVER_PORT=${input.runnerPort}`,
      `BASH_SERVER_ALLOWED_ROOTS=${input.filesystem.workspace.workerPath}`,
      ...(input.runnerSharedSecret ? [`BASH_SERVER_SHARED_SECRET=${input.runnerSharedSecret}`] : []),
      ...(input.managerUrl ? [`PANDA_WORKSPACE_EXEC_MANAGER_URL=${input.managerUrl}`] : []),
      `PANDA_WORKSPACE_EXEC_ENVIRONMENT_ID=${input.request.environmentId}`,
      `PANDA_WORKSPACE_EXEC_TOKEN=${input.workspaceExecToken}`,
      `PANDA_WORKSPACE_CONTAINER_NAME=${input.workspaceContainerName}`,
      `TZ=${safeEnv.TZ ?? "UTC"}`,
    ],
    WorkingDir: input.runnerCwd,
    Labels: buildLabels(input.request, "control", {"panda.environment.workspace_container": input.workspaceContainerName}),
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


function buildWorkspaceContainerConfig(input: {
  request: DisposableEnvironmentCreateRequest;
  image: string;
  runnerCwd: string;
  filesystem: ExecutionEnvironmentFilesystemMetadata;
  network?: string;
}): DockerContainerCreateConfig {
  const safeEnv = buildSafeCommandBaseEnv({TZ: process.env.TZ ?? "UTC"});
  return {
    Image: input.image,
    Cmd: ["sleep", "infinity"],
    Env: [
      `PATH=${safeEnv.PATH ?? ""}`,
      `SHELL=${safeEnv.SHELL ?? ""}`,
      `HOME=${safeEnv.HOME ?? ""}`,
      `TMPDIR=${safeEnv.TMPDIR ?? ""}`,
      `LANG=${safeEnv.LANG ?? ""}`,
      `TZ=${safeEnv.TZ ?? "UTC"}`,
    ],
    WorkingDir: input.runnerCwd,
    Labels: buildLabels(input.request, "workspace"),
    HostConfig: {
      AutoRemove: true,
      Init: true,
      Binds: [
        `${input.filesystem.workspace.hostPath}:${input.filesystem.workspace.workerPath}`,
        `${input.filesystem.inbox.hostPath}:${input.filesystem.inbox.workerPath}`,
        `${input.filesystem.artifacts.hostPath}:${input.filesystem.artifacts.workerPath}`,
      ],
      ...(input.network ? {NetworkMode: input.network} : {}),
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
  return readJsonHttpBody(request, {
    createError: createEnvironmentManagerBodyError,
    invalidJsonPrefix: "Environment manager request body must be valid JSON",
    maxBytes: MAX_ENVIRONMENT_MANAGER_JSON_BODY_BYTES,
    tooLargeMessage: "Environment manager request body is too large.",
  });
}

function createEnvironmentManagerBodyError(statusCode: number, message: string): ToolError {
  return new ToolError(message, {details: {statusCode}});
}

function parseRequestNetworkPolicy(value: unknown): ExecutionEnvironmentNetworkPolicy {
  try {
    return normalizeExecutionEnvironmentNetworkPolicy(value);
  } catch (error) {
    throw new ToolError(error instanceof Error ? error.message : "Invalid execution environment networkPolicy.");
  }
}

function validateCreateRequest(value: unknown): DisposableEnvironmentCreateRequest {
  if (!isRecord(value)) {
    throw new ToolError("Create disposable environment request must be an object.");
  }

  const agentKey = normalizeAgentKey(trimToNull(value.agentKey) ?? "");
  const sessionId = trimToNull(value.sessionId);
  const environmentId = trimToNull(value.environmentId);
  const networkPolicy = parseRequestNetworkPolicy(value.networkPolicy);
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
    networkPolicy,
    ...(ttlMs === undefined ? {} : {ttlMs}),
    ...(value.metadata === undefined ? {} : {metadata: validateManagerMetadata(value.metadata)}),
  };
}

function validateManagerMetadata(value: unknown): JsonValue {
  if (!isJsonValue(value)) {
    throw new ToolError("Execution environment manager metadata must be JSON-serializable.");
  }

  return value;
}

function validateCreateResult(result: DisposableEnvironmentCreateResult): DisposableEnvironmentCreateResult {
  const runnerUrl = trimToNull(result.runnerUrl);
  const runnerCwd = trimToNull(result.runnerCwd);
  if (!runnerUrl || !runnerCwd) {
    throw new ToolError("Execution environment manager create response is missing runner connection details.");
  }
  const rootPath = trimToUndefined(result.rootPath);
  return {
    runnerUrl,
    runnerCwd,
    ...(rootPath ? {rootPath} : {}),
    ...(result.metadata === undefined ? {} : {metadata: validateManagerMetadata(result.metadata)}),
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
  assertNoDeprecatedBashServerEnv(env, DOCKER_MANAGER_BASH_SERVER_ENV_NAMES);
  return {
    env,
    dockerHost: trimToUndefined(env.PANDA_DOCKER_HOST) ?? trimToUndefined(env.DOCKER_HOST) ?? DEFAULT_DOCKER_HOST,
    image: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_IMAGE) ?? undefined,
    controlRunnerImage: trimToUndefined(env.PANDA_DISPOSABLE_CONTROL_RUNNER_IMAGE)
      ?? trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_IMAGE)
      ?? DEFAULT_CONTROL_RUNNER_IMAGE,
    workspaceImage: trimToUndefined(env.PANDA_DISPOSABLE_WORKSPACE_IMAGE) ?? DEFAULT_WORKSPACE_IMAGE,
    workspaceExecSecret: trimToUndefined(env.PANDA_WORKSPACE_EXEC_SECRET),
    managerUrl: trimToUndefined(env.PANDA_EXECUTION_ENVIRONMENT_MANAGER_URL),
    network: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_NETWORK),
    localOnlyNetwork: trimToUndefined(env.PANDA_DISPOSABLE_LOCAL_ONLY_NETWORK),
    hostBindIp: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_HOST_BIND_IP) ?? DEFAULT_HOST_BIND_IP,
    hostRunnerHost: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_PUBLIC_HOST) ?? DEFAULT_HOST_BIND_IP,
    runnerPort: parsePort(trimToNull(env.PANDA_DISPOSABLE_RUNNER_PORT), DEFAULT_RUNNER_PORT),
    runnerCwd: trimToUndefined(env.PANDA_DISPOSABLE_RUNNER_CWD) ?? DEFAULT_RUNNER_CWD,
    runnerSharedSecret: trimToUndefined(env.BASH_SERVER_SHARED_SECRET),
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
  if (!isLoopbackHttpHostname(host) && !sharedSecret) {
    throw new Error("PANDA_EXECUTION_ENVIRONMENT_MANAGER_TOKEN is required when the environment manager binds outside loopback.");
  }

  return {
    ...resolveDockerExecutionEnvironmentManagerOptions(env),
    host,
    port: parsePort(trimToNull(env.PANDA_EXECUTION_ENVIRONMENT_MANAGER_PORT), DEFAULT_MANAGER_PORT),
    sharedSecret,
  };
}

const MAX_WORKSPACE_PROCESS_RECORDS = 128;
const WORKSPACE_PROCESS_TTL_MS = 60_000;

interface WorkspaceProcessRecord {
  environmentId: string;
  containerName: string;
  processId: string;
  execId?: string;
  pidFilePath: string;
  startedAt: number;
  request: WorkspaceExecStartRequest;
  snapshot: WorkspaceProcessSnapshot;
  completion: Promise<WorkspaceProcessSnapshot>;
}

export function demuxDockerStdCopyStream(stream: NodeJS.ReadableStream, onStdout: (chunk: Buffer) => void, onStderr: (chunk: Buffer) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const drain = () => {
      while (buffer.length >= 8) {
        const streamId = buffer[0];
        const length = buffer.readUInt32BE(4);
        if (buffer.length < 8 + length) return;
        const payload = buffer.subarray(8, 8 + length);
        buffer = buffer.subarray(8 + length);
        if (streamId === 1) onStdout(payload);
        else if (streamId === 2) onStderr(payload);
      }
    };
    stream.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      drain();
    });
    stream.on("end", () => { drain(); resolve(); });
    stream.on("error", reject);
  });
}

function validateWorkspaceExecAction(value: unknown): WorkspaceExecAction {
  if (!isRecord(value)) throw new ToolError("Workspace exec request body must be an object.");
  const action = value.action;
  const environmentId = trimToNull(typeof value.environmentId === "string" ? value.environmentId : null);
  if (!environmentId) throw new ToolError("environmentId must not be empty.");
  if (action === "start") {
    if (!isRecord(value.request)) throw new ToolError("Workspace exec start request must be an object.");
    const request = value.request;
    const mode = request.mode;
    if (mode !== "foreground" && mode !== "background") throw new ToolError("Workspace exec mode must be foreground or background.");
    const processId = request.processId === undefined ? undefined : validateProcessId(request.processId);
    const command = trimToNull(typeof request.command === "string" ? request.command : null);
    const cwd = trimToNull(typeof request.cwd === "string" ? request.cwd : null);
    const timeoutMs = typeof request.timeoutMs === "number" ? request.timeoutMs : NaN;
    const maxOutputChars = typeof request.maxOutputChars === "number" ? request.maxOutputChars : NaN;
    const trackedEnvKeys = Array.isArray(request.trackedEnvKeys) && request.trackedEnvKeys.every((entry) => typeof entry === "string") ? request.trackedEnvKeys : null;
    const env = request.env === undefined ? undefined : isRecord(request.env) && Object.values(request.env).every((entry) => typeof entry === "string") ? request.env as Record<string, string> : null;
    if (!command) throw new ToolError("Workspace exec command must not be empty.");
    if (!cwd || !path.posix.isAbsolute(cwd)) throw new ToolError("Workspace exec cwd must be an absolute path.");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300_000) throw new ToolError("Workspace exec timeoutMs must be an integer between 100 and 300000.");
    if (!Number.isInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > 1_000_000) throw new ToolError("Workspace exec maxOutputChars must be an integer between 1 and 1000000.");
    if (trackedEnvKeys === null) throw new ToolError("Workspace exec trackedEnvKeys must be an array of strings.");
    if (env === null) throw new ToolError("Workspace exec env must be an object of string values.");
    return {action: "start", environmentId, request: {mode, ...(processId ? {processId} : {}), command, cwd, timeoutMs, maxOutputChars, trackedEnvKeys, ...(env ? {env} : {})}};
  }
  if (action === "status" || action === "wait" || action === "cancel") {
    const processId = validateProcessId(value.processId);
    const timeoutMs = value.timeoutMs === undefined ? undefined : typeof value.timeoutMs === "number" ? value.timeoutMs : NaN;
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300_000)) throw new ToolError("Workspace exec timeoutMs must be an integer between 0 and 300000.");
    return {action, environmentId, processId, ...(timeoutMs === undefined ? {} : {timeoutMs})} as WorkspaceExecAction;
  }
  throw new ToolError("Unknown workspace exec action.");
}

function validateProcessId(value: unknown): string {
  const processId = trimToNull(typeof value === "string" ? value : null);
  if (!processId || processId.length > 160 || !/^[A-Za-z0-9:_.-]+$/.test(processId)) {
    throw new ToolError("Workspace exec processId is malformed.");
  }
  return processId;
}

function scopedProcessKey(environmentId: string, processId: string): string {
  return `${environmentId}\0${processId}`;
}

function makePreviewAppender(maxChars: number) {
  const capture = createOutputCapture(path.join(os.tmpdir(), `panda-workspace-discard-${randomBytes(8).toString("hex")}`));
  return {
    append(chunk: Buffer) { appendOutput(capture, chunk.toString("utf8"), maxChars); },
    state() { return capture; },
    async close() { await finalizeOutputCapture({capture, keepFile: false}); },
  };
}

function workspaceExecEnv(request: WorkspaceExecStartRequest): string[] {
  const safe = buildSafeCommandBaseEnv({TZ: process.env.TZ ?? "UTC"});
  return Object.entries({...safe, ...(request.env ?? {}), PANDA_WORKSPACE_COMMAND: request.command})
    .map(([key, value]) => `${key}=${value ?? ""}`);
}


function normalizeWorkspaceExecCwd(cwd: string): string {
  if (!path.posix.isAbsolute(cwd)) {
    throw new ToolError("Workspace exec cwd must be an absolute path under /workspace.", {details: {statusCode: 400, cwd}});
  }
  const normalized = path.posix.normalize(cwd);
  if (normalized !== DEFAULT_WORKER_WORKSPACE_PATH && !normalized.startsWith(`${DEFAULT_WORKER_WORKSPACE_PATH}/`)) {
    throw new ToolError("Workspace exec cwd must stay under /workspace.", {details: {statusCode: 400, cwd: normalized}});
  }
  return normalized;
}

function buildWorkspaceProcessWrapper(pidFilePath: string): string {
  return [
    "mkdir -p /tmp/panda-workspace-exec",
    `rm -f ${shellQuoteForDocker(pidFilePath)}`,
    "setsid bash -lc \"$PANDA_WORKSPACE_COMMAND\" &",
    "child=$!",
    `printf '%s' \"$child\" > ${shellQuoteForDocker(pidFilePath)}`,
    "wait \"$child\"",
  ].join("\n");
}

function shellQuoteForDocker(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class DockerExecutionEnvironmentManager implements ExecutionEnvironmentManager {
  private readonly docker: DockerClient;
  private readonly controlRunnerImage: string;
  private readonly workspaceImage: string;
  private readonly workspaceExecSecret: string;
  private readonly managerUrl?: string;
  private readonly network?: string;
  private readonly localOnlyNetwork?: string;
  private readonly hostBindIp: string;
  private readonly hostRunnerHost: string;
  private readonly runnerPort: number;
  private readonly runnerCwd: string;
  private readonly runnerSharedSecret?: string;
  private readonly hostEnvironmentsRoot: string;
  private readonly managerEnvironmentsRoot: string;
  private readonly coreEnvironmentsRoot: string;
  private readonly parentRunnerEnvironmentsRoot: string;
  private readonly containerNamePrefix: string;
  private readonly createTimeoutMs: number;
  private readonly workspaceProcesses = new Map<string, WorkspaceProcessRecord>();

  constructor(options: DockerExecutionEnvironmentManagerOptions = {}) {
    const resolved = {
      ...resolveDockerExecutionEnvironmentManagerOptions(options.env),
      ...options,
    };
    this.docker = resolved.dockerClient ?? new DockerEngineClient(resolved.dockerHost);
    this.controlRunnerImage = resolved.controlRunnerImage ?? resolved.image ?? DEFAULT_CONTROL_RUNNER_IMAGE;
    this.workspaceImage = resolved.workspaceImage ?? DEFAULT_WORKSPACE_IMAGE;
    this.workspaceExecSecret = trimToUndefined(resolved.workspaceExecSecret) ?? randomBytes(32).toString("base64url");
    this.managerUrl = trimToUndefined(resolved.managerUrl);
    this.network = trimToUndefined(resolved.network);
    this.localOnlyNetwork = trimToUndefined(resolved.localOnlyNetwork);
    this.hostBindIp = resolved.hostBindIp ?? DEFAULT_HOST_BIND_IP;
    this.hostRunnerHost = resolved.hostRunnerHost ?? DEFAULT_HOST_BIND_IP;
    this.runnerPort = resolved.runnerPort ?? DEFAULT_RUNNER_PORT;
    this.runnerCwd = resolved.runnerCwd ?? DEFAULT_RUNNER_CWD;
    this.runnerSharedSecret = trimToUndefined(resolved.runnerSharedSecret);
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

  private async resolveContainerNetwork(
    networkPolicy: ExecutionEnvironmentNetworkPolicy,
  ): Promise<string | undefined> {
    if (networkPolicy === "public") {
      return this.network;
    }

    if (!this.localOnlyNetwork) {
      throw new Error("local_only execution environments require PANDA_DISPOSABLE_LOCAL_ONLY_NETWORK.");
    }
    if (this.network && this.localOnlyNetwork === this.network) {
      throw new Error("local_only execution environments require PANDA_DISPOSABLE_LOCAL_ONLY_NETWORK to differ from PANDA_DISPOSABLE_RUNNER_NETWORK.");
    }
    const inspect = await this.docker.inspectNetwork(this.localOnlyNetwork);
    if (inspect.Internal !== true) {
      throw new Error(`Docker network ${this.localOnlyNetwork} must be internal for local_only execution environments.`);
    }
    return this.localOnlyNetwork;
  }

  async createDisposableEnvironment(
    input: DisposableEnvironmentCreateRequest,
  ): Promise<DisposableEnvironmentCreateResult> {
    const request = {
      ...input,
      agentKey: normalizeAgentKey(input.agentKey),
      environmentId: trimToNull(input.environmentId) ?? "",
      sessionId: trimToNull(input.sessionId) ?? "",
      networkPolicy: normalizeExecutionEnvironmentNetworkPolicy(input.networkPolicy),
    };
    if (!request.environmentId || !request.sessionId) {
      throw new Error("Disposable environment requests require environmentId and sessionId.");
    }

    const controlContainerName = buildContainerName(this.containerNamePrefix, request.environmentId, "control");
    const workspaceContainerName = buildContainerName(this.containerNamePrefix, request.environmentId, "workspace");
    const filesystem = buildFilesystemMetadata({
      agentKey: request.agentKey,
      environmentId: request.environmentId,
      hostRoot: this.hostEnvironmentsRoot,
      managerRoot: this.managerEnvironmentsRoot,
      coreRoot: this.coreEnvironmentsRoot,
      parentRunnerRoot: this.parentRunnerEnvironmentsRoot,
    });
    await ensureEnvironmentFilesystem(filesystem);
    const network = await this.resolveContainerNetwork(request.networkPolicy);
    const workspaceConfig = buildWorkspaceContainerConfig({
      request,
      image: this.workspaceImage,
      runnerCwd: this.runnerCwd,
      filesystem,
      network,
    });
    const workspaceExecToken = createWorkspaceExecCredential({
      environmentId: request.environmentId,
      secret: this.workspaceExecSecret,
    });
    const controlConfig = buildControlContainerConfig({
      request,
      image: this.controlRunnerImage,
      runnerPort: this.runnerPort,
      runnerCwd: this.runnerCwd,
      ...(this.runnerSharedSecret ? {runnerSharedSecret: this.runnerSharedSecret} : {}),
      workspaceExecToken,
      ...(this.managerUrl ? {managerUrl: this.managerUrl} : {}),
      workspaceContainerName,
      filesystem,
      network,
      hostBindIp: this.hostBindIp,
    });
    const createdContainers: string[] = [];
    let controlContainerId: string | undefined;
    let workspaceContainerId: string | undefined;
    let inspect: DockerContainerInspectResult;
    try {
      workspaceContainerId = await this.ensureContainer(workspaceContainerName, request, workspaceConfig);
      createdContainers.push(workspaceContainerName);
      await this.docker.startContainer(workspaceContainerId);
      controlContainerId = await this.ensureContainer(controlContainerName, request, controlConfig);
      createdContainers.push(controlContainerName);
      await this.docker.startContainer(controlContainerId);
      inspect = await this.waitForReady(controlContainerName);
    } catch (error) {
      await this.cleanupFailedCreate(createdContainers.length > 0 ? createdContainers : [controlContainerName, workspaceContainerName]);
      throw error;
    }

    const runnerUrl = network
      ? `http://${controlContainerName}:${this.runnerPort}`
      : `http://${this.hostRunnerHost}:${readPublishedPort(inspect, this.runnerPort)}`;
    return {
      runnerUrl,
      runnerCwd: this.runnerCwd,
      rootPath: this.runnerCwd,
      metadata: {
        filesystem: validateManagerMetadata(filesystem),
        containerId: inspect.Id || controlContainerId,
        containerName: controlContainerName,
        image: this.controlRunnerImage,
        networkPolicy: request.networkPolicy,
        controlContainer: {
          id: inspect.Id || controlContainerId,
          name: controlContainerName,
          image: this.controlRunnerImage,
        },
        workspaceContainer: {
          id: workspaceContainerId,
          name: workspaceContainerName,
          image: this.workspaceImage,
        },
        ...(network ? {network} : {}),
      },
    };
  }

  async stopEnvironment(environmentId: string): Promise<void> {
    const containerNames = [
      buildContainerName(this.containerNamePrefix, environmentId, "control"),
      buildContainerName(this.containerNamePrefix, environmentId, "workspace"),
    ];
    const errors: Error[] = [];
    for (const containerName of containerNames) {
      let inspect: DockerContainerInspectResult | null;
      try {
        inspect = await this.inspectManagedContainer(containerName, environmentId);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (!inspect) {
        continue;
      }
      try {
        await this.docker.stopContainer(containerName);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
      try {
        await this.docker.removeContainer(containerName);
      } catch (error) {
        if (!isAutoRemoveInProgress(error)) {
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    }
    for (const key of [...this.workspaceProcesses.keys()]) {
      if (key.startsWith(`${environmentId}\0`)) this.workspaceProcesses.delete(key);
    }
    if (errors.length === 1) {
      throw errors[0]!;
    }
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        `Failed to fully stop disposable environment ${environmentId}: ${errors.map((error) => error.message).join("; ")}`,
      );
    }
  }

  validateWorkspaceExecCredential(environmentId: string, credential: string): boolean {
    return validateWorkspaceExecCredential({
      environmentId,
      credential,
      secret: this.workspaceExecSecret,
    });
  }

  async handleWorkspaceExecAction(action: WorkspaceExecAction): Promise<WorkspaceProcessSnapshot> {
    this.evictWorkspaceProcesses();
    if (action.action === "start") return this.startWorkspaceProcess(action.environmentId, action.request);
    const record = this.workspaceProcesses.get(scopedProcessKey(action.environmentId, action.processId));
    if (!record) throw new ToolError(`Unknown workspace process ${action.processId}.`, {details: {statusCode: 404}});
    if (action.action === "status") return record.snapshot;
    if (action.action === "wait") return action.timeoutMs === undefined || action.timeoutMs > 0
      ? Promise.race([record.completion, sleep(action.timeoutMs ?? 15_000).then(() => record.snapshot)])
      : record.snapshot;
    return this.cancelWorkspaceProcess(record, action.timeoutMs ?? 1_000);
  }

  private async startWorkspaceProcess(environmentId: string, request: WorkspaceExecStartRequest): Promise<WorkspaceProcessSnapshot> {
    request = {...request, cwd: normalizeWorkspaceExecCwd(request.cwd)};
    const processId = request.processId ?? randomBytes(12).toString("base64url");
    const key = scopedProcessKey(environmentId, processId);
    if (this.workspaceProcesses.has(key)) throw new ToolError(`Workspace process ${processId} already exists.`, {details: {statusCode: 409}});
    if (this.workspaceProcesses.size >= MAX_WORKSPACE_PROCESS_RECORDS) {
      this.evictWorkspaceProcesses();
    }
    if (this.workspaceProcesses.size >= MAX_WORKSPACE_PROCESS_RECORDS) {
      throw new ToolError("Workspace process table is full; no terminal process records are available to evict.", {details: {statusCode: 429}});
    }
    const containerName = buildContainerName(this.containerNamePrefix, environmentId, "workspace");
    const inspect = await this.inspectManagedWorkspaceContainer(containerName, environmentId);
    if (!inspect?.State?.Running) throw new ToolError("Workspace container is not running.", {details: {statusCode: 409}});
    const now = Date.now();
    const pidFilePath = `/tmp/panda-workspace-exec/${processId.replace(/[^A-Za-z0-9_.-]/g, "_")}.pid`;
    const snapshot: WorkspaceProcessSnapshot = {
      processId,
      status: "running",
      command: request.command,
      initialCwd: request.cwd,
      startedAt: now,
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
      trackedEnvKeys: request.trackedEnvKeys,
    };
    const record: WorkspaceProcessRecord = {environmentId, containerName, processId, pidFilePath, startedAt: now, request, snapshot, completion: Promise.resolve(snapshot)};
    this.workspaceProcesses.set(key, record);
    record.completion = this.runWorkspaceProcess(record);
    if (request.mode === "foreground") return record.completion;
    return snapshot;
  }

  private async runWorkspaceProcess(record: WorkspaceProcessRecord): Promise<WorkspaceProcessSnapshot> {
    const stdout = makePreviewAppender(record.request.maxOutputChars);
    const stderr = makePreviewAppender(record.request.maxOutputChars);
    let timeout: NodeJS.Timeout | undefined;
    try {
      const created = await this.docker.createExec(record.containerName, {
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: ["bash", "-lc", buildWorkspaceProcessWrapper(record.pidFilePath)],
        WorkingDir: record.request.cwd,
        Env: workspaceExecEnv(record.request),
      });
      record.execId = created.Id;
      const stream = await this.docker.startExec(created.Id, {Detach: false, Tty: false});
      timeout = setTimeout(() => {
        record.snapshot.timedOut = true;
        void this.cancelWorkspaceProcess(record, 1_000);
      }, record.request.timeoutMs);
      timeout.unref();
      await demuxDockerStdCopyStream(stream, (chunk) => stdout.append(chunk), (chunk) => stderr.append(chunk));
      const inspect = await this.waitForDockerExecCompletion(created.Id);
      const exitCode = inspect.ExitCode ?? null;
      const timedOut = record.snapshot.timedOut;
      const cancelled = record.snapshot.status === "cancelled";
      record.snapshot = {
        ...record.snapshot,
        status: cancelled ? "cancelled" : exitCode === 0 ? "completed" : "failed",
        finishedAt: Date.now(),
        durationMs: Date.now() - record.startedAt,
        exitCode,
        signal: null,
        timedOut,
        aborted: cancelled,
        abortReason: cancelled ? "Command aborted." : null,
        stdout: stdout.state().preview,
        stderr: stderr.state().preview,
        stdoutTruncated: stdout.state().previewTruncated,
        stderrTruncated: stderr.state().previewTruncated,
        stdoutChars: stdout.state().totalChars,
        stderrChars: stderr.state().totalChars,
      };
      return record.snapshot;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record.snapshot = {...record.snapshot, status: "failed", finishedAt: Date.now(), durationMs: Date.now() - record.startedAt, exitCode: null, signal: null, stderr: message, stderrChars: message.length};
      return record.snapshot;
    } finally {
      if (timeout) clearTimeout(timeout);
      await Promise.all([stdout.close(), stderr.close()]);
    }
  }


  private async waitForDockerExecCompletion(execId: string): Promise<DockerExecInspectResult> {
    const deadline = Date.now() + DOCKER_EXEC_COMPLETION_WAIT_MS;
    let inspect = await this.docker.inspectExec(execId);
    while ((inspect.Running === true || inspect.ExitCode == null) && Date.now() < deadline) {
      await sleep(DOCKER_EXEC_COMPLETION_POLL_MS);
      inspect = await this.docker.inspectExec(execId);
    }
    return inspect;
  }

  private async cancelWorkspaceProcess(record: WorkspaceProcessRecord, timeoutMs: number): Promise<WorkspaceProcessSnapshot> {
    const now = Date.now();
    record.snapshot = {
      ...record.snapshot,
      status: "cancelled",
      aborted: true,
      abortReason: "Command aborted.",
      finishedAt: record.snapshot.finishedAt ?? now,
      durationMs: record.snapshot.durationMs ?? now - record.startedAt,
    };
    const script = `pid=$(cat ${shellQuoteForDocker(record.pidFilePath)} 2>/dev/null || true); if [ -n "$pid" ]; then kill -TERM -"$pid" 2>/dev/null || true; sleep ${Math.min(Math.max(timeoutMs, 0), 5000) / 1000}; kill -KILL -"$pid" 2>/dev/null || true; fi`;
    try {
      const created = await this.docker.createExec(record.containerName, {AttachStdout: true, AttachStderr: true, Tty: false, Cmd: ["bash", "-lc", script], WorkingDir: "/", Env: []});
      const stream = await this.docker.startExec(created.Id, {Detach: false, Tty: false});
      await Promise.race([
        demuxDockerStdCopyStream(stream, () => undefined, () => undefined),
        sleep(Math.min(Math.max(timeoutMs, 0), 5_000)),
      ]);
    } catch {
      // Best-effort protocol plumbing; B2b proves process-tree hardening with real Docker.
    }
    return record.snapshot;
  }

  private evictWorkspaceProcesses(): void {
    const now = Date.now();
    for (const [key, record] of this.workspaceProcesses) {
      if (record.snapshot.status !== "running" && now - (record.snapshot.finishedAt ?? record.startedAt) > WORKSPACE_PROCESS_TTL_MS) {
        this.workspaceProcesses.delete(key);
      }
      if (this.workspaceProcesses.size < MAX_WORKSPACE_PROCESS_RECORDS) break;
    }
  }

  private async cleanupFailedCreate(containers: string | readonly string[]): Promise<void> {
    const containerNames = Array.isArray(containers) ? [...containers].reverse() : [containers];
    for (const container of containerNames) {
      try {
        await this.docker.stopContainer(container);
      } catch {
        // Best effort. A failed start may leave nothing to stop.
      }
      try {
        await this.docker.removeContainer(container);
      } catch (error) {
        if (isAutoRemoveInProgress(error)) {
          continue;
        }
      }
    }
  }

  private assertReusableContainer(
    containerName: string,
    inspect: DockerContainerInspectResult,
    request: DisposableEnvironmentCreateRequest,
    config: DockerContainerCreateConfig,
  ): void {
    const requestedPolicy = normalizeExecutionEnvironmentNetworkPolicy(request.networkPolicy);
    const existingPolicyLabel = inspect.Config?.Labels?.["panda.environment.network_policy"];
    const actualNetwork = trimToUndefined(inspect.HostConfig?.NetworkMode);
    const expectedNetwork = trimToUndefined(config.HostConfig.NetworkMode);

    if (existingPolicyLabel === undefined) {
      if (requestedPolicy !== "public") {
        throw new Error(`Existing disposable environment container ${containerName} is missing networkPolicy label for requested ${requestedPolicy}.`);
      }
      if (this.localOnlyNetwork && actualNetwork === this.localOnlyNetwork) {
        throw new Error(`Existing disposable environment container ${containerName} is on local-only Docker network ${actualNetwork} but requested public.`);
      }
    } else {
      let existingPolicy: ExecutionEnvironmentNetworkPolicy;
      try {
        existingPolicy = normalizeExecutionEnvironmentNetworkPolicy(existingPolicyLabel);
      } catch {
        throw new Error(`Existing disposable environment container ${containerName} has unsupported networkPolicy label ${existingPolicyLabel}.`);
      }
      if (existingPolicy !== requestedPolicy) {
        throw new Error(`Existing disposable environment container ${containerName} networkPolicy ${existingPolicy} does not match requested ${requestedPolicy}.`);
      }
    }

    if (!expectedNetwork && requestedPolicy === "public" && this.localOnlyNetwork && actualNetwork === this.localOnlyNetwork) {
      throw new Error(`Existing disposable environment container ${containerName} is on local-only Docker network ${actualNetwork} but requested public.`);
    }
    if (expectedNetwork && actualNetwork !== expectedNetwork) {
      throw new Error(`Existing disposable environment container ${containerName} Docker network ${actualNetwork ?? "-"} does not match requested ${expectedNetwork}.`);
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
      this.assertReusableContainer(containerName, existing, request, config);
      return existing.Id;
    }
  }

  private async inspectManagedWorkspaceContainer(containerName: string, environmentId: string): Promise<DockerContainerInspectResult | null> {
    const inspect = await this.inspectManagedContainer(containerName, environmentId);
    if (inspect && inspect.Config?.Labels?.["panda.environment.role"] !== "workspace") {
      throw new Error(`Refusing to exec non-workspace container ${containerName}.`);
    }
    return inspect;
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
      await sleep(500);
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
  if (!isLoopbackHttpHostname(host) && !sharedSecret) {
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

      const body = await readJsonBody(request);
      if (requestUrl.pathname === "/workspaces/exec") {
        if (!hasWorkspaceExecCredentialValidator(manager)) {
          throw new ToolError("Workspace exec is not supported by this environment manager.", {details: {statusCode: 501}});
        }
        const authScope = validateEnvironmentIdRequest(body);
        requireWorkspaceExecAuthorization(request, authScope.environmentId, manager);
        if (!hasWorkspaceExecActionHandler(manager)) {
          throw new ToolError("Workspace exec is not supported by this environment manager.", {details: {statusCode: 501}});
        }
        const parsed = validateWorkspaceExecAction(body);
        const process = await manager.handleWorkspaceExecAction(parsed);
        writeJsonResponse(response, 200, {ok: true, process});
        return;
      }

      requireAuthorization(request, sharedSecret);
      if (requestUrl.pathname === "/environments/disposable") {
        const result = validateCreateResult(await manager.createDisposableEnvironment(validateCreateRequest(body)));
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
