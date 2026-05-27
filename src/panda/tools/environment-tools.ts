import {constants as fsConstants} from "node:fs";
import {access, stat} from "node:fs/promises";

import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import {isJsonObject, type JsonObject} from "../../lib/json.js";
import type {ExecutionEnvironmentRecord} from "../../domain/execution-environments/types.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/filesystem.js";
import {
  readExecutionEnvironmentSetupMetadata,
  SETUP_SCRIPT_INSPECTION_NOTE,
  type ExecutionEnvironmentSetupScriptInput,
} from "../../domain/execution-environments/setup.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {resolveReadableContextPath} from "../../app/runtime/panda-path-context.js";
import {readRequiredAgentSessionToolScope, rethrowAsToolError} from "./shared.js";

const DEFAULT_ENVIRONMENT_TTL_MS = 24 * 60 * 60 * 1_000;

function compactObject<T extends Record<string, unknown>>(value: T): JsonObject {
  const compacted = Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
  if (isJsonObject(compacted)) {
    return compacted;
  }

  throw new ToolError("Environment tool payload must be a JSON object.");
}

function readScope(context: DefaultAgentSessionContext | undefined): {
  agentKey: string;
  sessionId: string;
} {
  return readRequiredAgentSessionToolScope(
    context,
    "Environment tools require agentKey and sessionId in the runtime session context.",
  );
}

interface ExecutionEnvironmentCreator {
  createStandaloneDisposableEnvironment(input: {
    agentKey: string;
    createdBySessionId: string;
    ttlMs?: number;
    metadata?: JsonObject;
    setupScript?: ExecutionEnvironmentSetupScriptInput;
  }): Promise<ExecutionEnvironmentRecord>;
}

interface ExecutionEnvironmentStopper {
  stopEnvironment(environmentId: string): Promise<ExecutionEnvironmentRecord>;
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

function serializeEnvironment(environment: ExecutionEnvironmentRecord): JsonObject {
  return compactObject({
    environmentId: environment.id,
    environmentState: environment.state,
    runnerCwd: environment.runnerCwd,
    rootPath: environment.rootPath,
    expiresAt: environment.expiresAt,
    paths: readParentVisiblePaths(environment),
    setup: readExecutionEnvironmentSetupMetadata(environment.metadata) ?? undefined,
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

async function resolveSetupScriptInput(
  rawPath: string | undefined,
  context: DefaultAgentSessionContext | undefined,
): Promise<ExecutionEnvironmentSetupScriptInput | undefined> {
  if (rawPath === undefined) {
    return undefined;
  }

  const requestedPath = rawPath.trim();
  const resolvedPath = await resolveReadableContextPath(requestedPath, context);
  const file = await stat(resolvedPath).catch(() => null);
  if (!file) {
    throw new ToolError(`No readable setup script found at ${requestedPath}.`);
  }

  if (!file.isFile()) {
    throw new ToolError(`setupScript must point to a regular .sh file: ${requestedPath}.`);
  }
  if (!requestedPath.endsWith(".sh") || !resolvedPath.endsWith(".sh")) {
    throw new ToolError(`setupScript must point to a .sh file: ${requestedPath}.`);
  }
  if ((file.mode & 0o444) === 0) {
    throw new ToolError(`Setup script is not readable: ${requestedPath}.`);
  }
  try {
    await access(resolvedPath, fsConstants.R_OK);
  } catch {
    throw new ToolError(`Setup script is not readable: ${requestedPath}.`);
  }

  return {
    requestedPath,
    resolvedPath,
  };
}

export interface EnvironmentCreateToolOptions {
  lifecycle: ExecutionEnvironmentCreator;
}

export class EnvironmentCreateTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof EnvironmentCreateTool.schema, TContext> {
  static schema = z.object({
    label: z.string().trim().min(1).max(80).optional(),
    ttlHours: z.number().positive().max(24 * 30).optional(),
    setupScript: z.string().trim().min(1).optional().describe(
      `Path to a readable .sh script to copy into the new environment and run before it is marked ready. ${SETUP_SCRIPT_INSPECTION_NOTE}`,
    ),
  });

  name = "environment_create";
  description = `Create a disposable execution environment owned by this session. Optionally run a readable .sh setupScript before the environment is marked ready. ${SETUP_SCRIPT_INSPECTION_NOTE}`;
  schema = EnvironmentCreateTool.schema;

  private readonly lifecycle: ExecutionEnvironmentCreator;

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
    const context = run.context as DefaultAgentSessionContext | undefined;
    const scope = readScope(context);
    const setupScript = await resolveSetupScriptInput(args.setupScript, context);
    const environment = await this.lifecycle.createStandaloneDisposableEnvironment({
      agentKey: scope.agentKey,
      createdBySessionId: scope.sessionId,
      ttlMs: args.ttlHours === undefined
        ? DEFAULT_ENVIRONMENT_TTL_MS
        : Math.round(args.ttlHours * 60 * 60 * 1_000),
      metadata: compactObject({
        ...(args.label ? {label: args.label} : {}),
        createdByTool: "environment_create",
      }),
      ...(setupScript ? {setupScript} : {}),
    }).catch((error: unknown) => rethrowAsToolError(error));

    return {
      status: "created",
      ...serializeEnvironment(environment),
    };
  }
}

export interface EnvironmentStopToolOptions {
  environments: Pick<ExecutionEnvironmentStore, "getEnvironment">;
  lifecycle: ExecutionEnvironmentStopper;
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
  private readonly lifecycle: ExecutionEnvironmentStopper;

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
    const current = await this.environments.getEnvironment(args.environmentId)
      .catch((error: unknown) => rethrowAsToolError(error));
    validateOwnedDisposableEnvironment({environment: current, scope});
    const alreadyTerminal = current.state === "stopped" || current.state === "failed";
    const environment = alreadyTerminal || current.state === "stopping"
      ? current
      : await this.lifecycle.stopEnvironment(current.id).catch((error: unknown) => rethrowAsToolError(error));

    return {
      status: current.state === "failed"
        ? "failed"
        : alreadyTerminal
          ? "already_stopped"
          : environment.state,
      ...serializeEnvironment(environment),
    };
  }
}
