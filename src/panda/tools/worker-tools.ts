import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject} from "../../kernel/agent/types.js";
import {readWorkerSessionMetadata} from "../../domain/sessions/worker-metadata.js";
import type {
  ExecutionEnvironmentRecord,
  ExecutionEnvironmentStore,
} from "../../domain/execution-environments/index.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/index.js";
import {
  DEFAULT_WORKER_ENVIRONMENT_TTL_MS,
  type WorkerSessionService,
} from "../../app/runtime/worker-session-service.js";
import type {ExecutionEnvironmentLifecycleService} from "../../app/runtime/execution-environment-service.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {resolveDefaultAgentWorkerModelSelector} from "../defaults.js";
import {
  buildDefaultWorkerAllowedTools,
  KNOWN_WORKER_TOOL_NAMES,
  normalizeToolName,
  POSTGRES_READONLY_TOOL_NAME,
  WORKER_CONTROL_TOOL_NAMES,
} from "./worker-tool-policy.js";

function compactObject<T extends Record<string, unknown>>(value: T): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as JsonObject;
}

function readScope(context: DefaultAgentSessionContext | undefined): {
  agentKey: string;
  sessionId: string;
  identityId?: string;
} {
  const agentKey = context?.agentKey?.trim();
  const sessionId = context?.sessionId?.trim();
  if (!agentKey || !sessionId) {
    throw new ToolError("Worker tools require agentKey and sessionId in the runtime session context.");
  }

  const identityId = context?.currentInput?.identityId?.trim();
  return {
    agentKey,
    sessionId,
    ...(identityId ? {identityId} : {}),
  };
}

function ensureWorkerA2A(context: DefaultAgentSessionContext | undefined): NonNullable<DefaultAgentSessionContext["workerA2A"]> {
  const service = context?.workerA2A;
  if (!service) {
    throw new ToolError("worker_spawn is unavailable because worker A2A binding is not configured.");
  }

  return service;
}

function readParentVisiblePaths(environment: ExecutionEnvironmentRecord): JsonObject | undefined {
  const filesystem = readExecutionEnvironmentFilesystemMetadata(environment.metadata);
  if (!filesystem) {
    return undefined;
  }

  return compactObject({
    root: filesystem.root.parentRunnerPath,
    workspace: filesystem.workspace.parentRunnerPath,
    inbox: filesystem.inbox.parentRunnerPath,
    artifacts: filesystem.artifacts.parentRunnerPath,
  });
}

function serializeWorkerEnvironment(environment: ExecutionEnvironmentRecord): JsonObject {
  return compactObject({
    environmentId: environment.id,
    environmentState: environment.state,
    runnerCwd: environment.runnerCwd,
    rootPath: environment.rootPath,
    expiresAt: environment.expiresAt,
    paths: readParentVisiblePaths(environment),
  });
}

function validateOwnedDisposableEnvironment(input: {
  environment: ExecutionEnvironmentRecord;
  scope: {agentKey: string; sessionId: string};
}): void {
  if (input.environment.kind !== "disposable_container") {
    throw new ToolError(`Execution environment ${input.environment.id} is not disposable.`);
  }
  if (input.environment.agentKey !== input.scope.agentKey) {
    throw new ToolError(`Execution environment ${input.environment.id} does not belong to agent ${input.scope.agentKey}.`);
  }
  if (input.environment.createdBySessionId !== input.scope.sessionId) {
    throw new ToolError(`Execution environment ${input.environment.id} is not owned by this session.`);
  }
}

export interface WorkerSpawnToolOptions {
  workerSessions: Pick<WorkerSessionService, "createWorkerSession">;
  env?: NodeJS.ProcessEnv;
  availableToolNames?: () => readonly string[];
}

export class WorkerSpawnTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof WorkerSpawnTool.schema, TContext> {
  static schema = z.object({
    role: z.string().trim().min(1).max(80).optional(),
    task: z.string().trim().min(1),
    context: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    environmentId: z.string().trim().min(1).optional(),
    credentialAllowlist: z.array(z.string().trim().min(1)).max(50).optional(),
    skillAllowlist: z.array(z.string().trim().min(1)).max(50).optional(),
    toolAllowlist: z.array(z.string().trim().min(1)).max(50).optional(),
    allowReadonlyPostgres: z.boolean().optional(),
  });

  name = "worker_spawn";
  description = "Spawn a disposable worker session for scoped work. By default it creates a fresh environment; pass environmentId to attach to an existing environment.";
  schema = WorkerSpawnTool.schema;

  private readonly workerSessions: Pick<WorkerSessionService, "createWorkerSession">;
  private readonly env: NodeJS.ProcessEnv;
  private readonly availableToolNames?: () => readonly string[];

  constructor(options: WorkerSpawnToolOptions) {
    super();
    this.workerSessions = options.workerSessions;
    this.env = options.env ?? process.env;
    this.availableToolNames = options.availableToolNames;
  }

  override formatCall(args: Record<string, unknown>): string {
    const role = typeof args.role === "string" ? args.role : "worker";
    const task = typeof args.task === "string" ? args.task : "";
    return `${role}: ${task}`.trim();
  }

  override formatResult(message: ToolResultMessage): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return message.isError ? "Worker spawn failed." : "Worker spawned.";
    }

    const sessionId = typeof details.sessionId === "string" ? details.sessionId : undefined;
    const environmentId = typeof details.environmentId === "string" ? details.environmentId : undefined;
    return [
      "worker spawned",
      sessionId ? `session ${sessionId}` : "",
      environmentId ? `environment ${environmentId}` : "",
    ].filter(Boolean).join("\n");
  }

  async handle(
    args: z.output<typeof WorkerSpawnTool.schema>,
    run: RunContext<TContext>,
  ): Promise<JsonObject> {
    const context = run.context as DefaultAgentSessionContext | undefined;
    const scope = readScope(context);
    const workerA2A = ensureWorkerA2A(context);
    const defaultModel = resolveDefaultAgentWorkerModelSelector(this.env);
    const extraTools = this.validateToolAllowlist(args.toolAllowlist ?? [], args.allowReadonlyPostgres === true);
    const created = await this.workerSessions.createWorkerSession({
      agentKey: scope.agentKey,
      role: args.role,
      task: args.task,
      context: args.context,
      parentSessionId: scope.sessionId,
      createdByIdentityId: scope.identityId,
      model: args.model ?? defaultModel,
      environmentId: args.environmentId,
      credentialAllowlist: args.credentialAllowlist ?? [],
      skillAllowlist: args.skillAllowlist ?? [],
      toolPolicy: {
        allowedTools: buildDefaultWorkerAllowedTools({
          allowReadonlyPostgres: args.allowReadonlyPostgres === true,
          extraTools,
        }),
        bash: {allowed: true},
        ...(args.allowReadonlyPostgres ? {postgresReadonly: {allowed: true}} : {}),
      },
      beforeHandoff: async (result) => {
        await workerA2A.bindParentWorker({
          parentSessionId: scope.sessionId,
          workerSessionId: result.session.id,
        });
      },
    });

    return {
      status: "spawned",
      sessionId: created.session.id,
      threadId: created.thread.id,
      role: readWorkerSessionMetadata(created.session.metadata)?.role ?? args.role ?? "worker",
      ...serializeWorkerEnvironment(created.environment),
    };
  }

  private validateToolAllowlist(values: readonly string[], allowReadonlyPostgres: boolean): string[] {
    const requested = [...new Set(values.map(normalizeToolName).filter(Boolean))];
    const available = this.availableToolNames ? new Set(this.availableToolNames()) : null;

    for (const toolName of requested) {
      if (WORKER_CONTROL_TOOL_NAMES.has(toolName)) {
        throw new ToolError(`${toolName} cannot be granted to worker sessions.`);
      }
      if (!KNOWN_WORKER_TOOL_NAMES.has(toolName)) {
        throw new ToolError(`Unknown worker tool: ${toolName}.`);
      }
      if (toolName === POSTGRES_READONLY_TOOL_NAME && !allowReadonlyPostgres) {
        throw new ToolError("postgres_readonly_query requires allowReadonlyPostgres=true.");
      }
      if (available && !available.has(toolName)) {
        throw new ToolError(`Tool ${toolName} is not available in this runtime.`);
      }
    }

    return requested;
  }
}

export interface EnvironmentCreateToolOptions {
  lifecycle: Pick<ExecutionEnvironmentLifecycleService, "createStandaloneDisposableEnvironment">;
}

export class EnvironmentCreateTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof EnvironmentCreateTool.schema, TContext> {
  static schema = z.object({
    label: z.string().trim().min(1).max(80).optional(),
    ttlHours: z.number().positive().max(24 * 30).optional(),
  });

  name = "environment_create";
  description = "Create a disposable execution environment owned by this session. Files are preserved when the environment is stopped.";
  schema = EnvironmentCreateTool.schema;

  private readonly lifecycle: Pick<ExecutionEnvironmentLifecycleService, "createStandaloneDisposableEnvironment">;

  constructor(options: EnvironmentCreateToolOptions) {
    super();
    this.lifecycle = options.lifecycle;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.label === "string" ? args.label : "environment";
  }

  override formatResult(message: ToolResultMessage): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return message.isError ? "Environment create failed." : "Environment created.";
    }

    const environmentId = typeof details.environmentId === "string" ? details.environmentId : undefined;
    return environmentId ? `environment created\n${environmentId}` : "environment created";
  }

  async handle(
    args: z.output<typeof EnvironmentCreateTool.schema>,
    run: RunContext<TContext>,
  ): Promise<JsonObject> {
    const scope = readScope(run.context as DefaultAgentSessionContext | undefined);
    const environment = await this.lifecycle.createStandaloneDisposableEnvironment({
      agentKey: scope.agentKey,
      createdBySessionId: scope.sessionId,
      ttlMs: args.ttlHours === undefined
        ? DEFAULT_WORKER_ENVIRONMENT_TTL_MS
        : Math.round(args.ttlHours * 60 * 60 * 1_000),
      metadata: compactObject({
        ...(args.label ? {label: args.label} : {}),
        createdByTool: "environment_create",
      }),
    });

    return {
      status: "created",
      ...serializeWorkerEnvironment(environment),
    };
  }
}

export interface EnvironmentStopToolOptions {
  environments: Pick<ExecutionEnvironmentStore, "getEnvironment">;
  lifecycle: Pick<ExecutionEnvironmentLifecycleService, "stopEnvironment">;
}

export class EnvironmentStopTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof EnvironmentStopTool.schema, TContext> {
  static schema = z.object({
    environmentId: z.string().trim().min(1),
  });

  name = "environment_stop";
  description = "Stop a disposable execution environment owned by this session. Files and DB records are preserved.";
  schema = EnvironmentStopTool.schema;

  private readonly environments: Pick<ExecutionEnvironmentStore, "getEnvironment">;
  private readonly lifecycle: Pick<ExecutionEnvironmentLifecycleService, "stopEnvironment">;

  constructor(options: EnvironmentStopToolOptions) {
    super();
    this.environments = options.environments;
    this.lifecycle = options.lifecycle;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.environmentId === "string" ? args.environmentId : "environment";
  }

  override formatResult(message: ToolResultMessage): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return message.isError ? "Environment stop failed." : "Environment stopped.";
    }

    const status = typeof details.status === "string" ? details.status : "stopped";
    const environmentId = typeof details.environmentId === "string" ? details.environmentId : undefined;
    return [
      status,
      environmentId ? `environment ${environmentId}` : "",
    ].filter(Boolean).join("\n");
  }

  async handle(
    args: z.output<typeof EnvironmentStopTool.schema>,
    run: RunContext<TContext>,
  ): Promise<JsonObject> {
    const scope = readScope(run.context as DefaultAgentSessionContext | undefined);
    const current = await this.environments.getEnvironment(args.environmentId);
    validateOwnedDisposableEnvironment({environment: current, scope});
    const alreadyTerminal = current.state === "stopped" || current.state === "failed";
    const environment = alreadyTerminal || current.state === "stopping"
      ? current
      : await this.lifecycle.stopEnvironment(current.id);

    return {
      status: current.state === "failed"
        ? "failed"
        : alreadyTerminal
          ? "already_stopped"
          : environment.state,
      ...serializeWorkerEnvironment(environment),
    };
  }
}
