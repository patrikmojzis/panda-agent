import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {JsonObject} from "../../kernel/agent/types.js";
import type {SessionRecord, SessionStore} from "../../domain/sessions/index.js";
import {readWorkerSessionMetadata} from "../../domain/sessions/worker-metadata.js";
import type {
  ExecutionEnvironmentRecord,
  ExecutionEnvironmentStore,
} from "../../domain/execution-environments/index.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/index.js";
import type {WorkerSessionService} from "../../app/runtime/worker-session-service.js";
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

function validateOwnedWorkerSession(input: {
  session: SessionRecord;
  scope: {agentKey: string; sessionId: string};
}): void {
  if (input.session.kind !== "worker") {
    throw new ToolError(`Session ${input.session.id} is not a worker session.`);
  }
  if (input.session.agentKey !== input.scope.agentKey) {
    throw new ToolError(`Worker session ${input.session.id} does not belong to agent ${input.scope.agentKey}.`);
  }

  const metadata = readWorkerSessionMetadata(input.session.metadata);
  if (metadata?.parentSessionId !== input.scope.sessionId) {
    throw new ToolError(`Worker session ${input.session.id} is not owned by this session.`);
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
    credentialAllowlist: z.array(z.string().trim().min(1)).max(50).optional(),
    skillAllowlist: z.array(z.string().trim().min(1)).max(50).optional(),
    toolAllowlist: z.array(z.string().trim().min(1)).max(50).optional(),
    allowReadonlyPostgres: z.boolean().optional(),
  });

  name = "worker_spawn";
  description = "Spawn an isolated disposable worker session for scoped work. The worker receives a fresh bash environment and reports back with message_agent.";
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

export interface WorkerStopToolOptions {
  sessions: Pick<SessionStore, "getSession">;
  environments: Pick<ExecutionEnvironmentStore, "getDefaultBinding" | "getEnvironment">;
  lifecycle: Pick<ExecutionEnvironmentLifecycleService, "stopEnvironment">;
}

const workerStopSchema = z.object({
  sessionId: z.string().trim().min(1).optional(),
  environmentId: z.string().trim().min(1).optional(),
}).superRefine((value, ctx) => {
  if (!value.sessionId && !value.environmentId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sessionId"],
      message: "worker_stop requires sessionId or environmentId.",
    });
  }
});

export class WorkerStopTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof workerStopSchema, TContext> {
  static schema = workerStopSchema;

  name = "worker_stop";
  description = "Stop a disposable worker environment owned by the current session. Files are preserved for review.";
  schema = WorkerStopTool.schema;

  private readonly sessions: Pick<SessionStore, "getSession">;
  private readonly environments: Pick<ExecutionEnvironmentStore, "getDefaultBinding" | "getEnvironment">;
  private readonly lifecycle: Pick<ExecutionEnvironmentLifecycleService, "stopEnvironment">;

  constructor(options: WorkerStopToolOptions) {
    super();
    this.sessions = options.sessions;
    this.environments = options.environments;
    this.lifecycle = options.lifecycle;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.sessionId === "string"
      ? args.sessionId
      : typeof args.environmentId === "string"
        ? args.environmentId
        : "worker";
  }

  override formatResult(message: ToolResultMessage): string {
    const details = message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return message.isError ? "Worker stop failed." : "Worker stopped.";
    }

    const status = typeof details.status === "string" ? details.status : "stopped";
    const sessionId = typeof details.sessionId === "string" ? details.sessionId : undefined;
    const environmentId = typeof details.environmentId === "string" ? details.environmentId : undefined;
    return [
      status,
      sessionId ? `session ${sessionId}` : "",
      environmentId ? `environment ${environmentId}` : "",
    ].filter(Boolean).join("\n");
  }

  private async resolveTarget(args: z.output<typeof workerStopSchema>, scope: {
    agentKey: string;
    sessionId: string;
  }): Promise<{session?: SessionRecord; environment: ExecutionEnvironmentRecord}> {
    if (args.sessionId) {
      const session = await this.sessions.getSession(args.sessionId);
      validateOwnedWorkerSession({session, scope});
      const binding = await this.environments.getDefaultBinding(session.id);
      if (!binding) {
        throw new ToolError(`Worker session ${session.id} has no default execution environment.`);
      }
      return {
        session,
        environment: await this.environments.getEnvironment(binding.environmentId),
      };
    }

    const environment = await this.environments.getEnvironment(args.environmentId ?? "");
    if (environment.agentKey !== scope.agentKey) {
      throw new ToolError(`Execution environment ${environment.id} does not belong to agent ${scope.agentKey}.`);
    }
    if (environment.createdForSessionId) {
      const session = await this.sessions.getSession(environment.createdForSessionId);
      validateOwnedWorkerSession({session, scope});
      return {session, environment};
    }
    if (environment.createdBySessionId !== scope.sessionId) {
      throw new ToolError(`Execution environment ${environment.id} is not owned by this session.`);
    }

    return {environment};
  }

  async handle(
    args: z.output<typeof workerStopSchema>,
    run: RunContext<TContext>,
  ): Promise<JsonObject> {
    const scope = readScope(run.context as DefaultAgentSessionContext | undefined);
    const target = await this.resolveTarget(args, scope);
    const current = target.environment;
    const alreadyTerminal = current.state === "stopped" || current.state === "failed";
    const environment = alreadyTerminal || current.state === "stopping"
      ? current
      : await this.lifecycle.stopEnvironment(current.id);

    return {
      status: alreadyTerminal ? "already_stopped" : environment.state,
      ...(target.session ? {sessionId: target.session.id} : {}),
      ...serializeWorkerEnvironment(environment),
    };
  }
}
