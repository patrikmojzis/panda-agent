import {randomUUID} from "node:crypto";

import {isJsonObject, type JsonObject, type JsonValue} from "../../lib/json.js";
import {
  CommandDenialError,
  CommandStructuredError,
  commandCapabilityDenied,
  commandUnauthorized,
  type CommandDenialFailureCode,
} from "../../domain/commands/errors.js";
import {
    isCommandAllowed,
} from "../../domain/commands/registry.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ThreadToolJobRecord} from "../../domain/threads/runtime/types.js";
import type {
    CommandAuditMetadata,
    CommandDescriptor,
    CommandError,
    CommandErrorCode,
    CommandExecutor,
    CommandName,
    CommandRequest,
    CommandResult,
    CommandScope,
    RegisteredCommand,
} from "../../domain/commands/types.js";
import {COMMAND_AUDIT_METADATA} from "../../domain/commands/types.js";

type CommandAuditStore = Pick<ThreadRuntimeStore, "createToolJob" | "updateToolJob">;
type CommandScopeResolver = (scope: CommandScope) => Promise<CommandScope> | CommandScope;
const MAX_SAFE_RETRY_AFTER_MS = 31 * 24 * 60 * 60 * 1_000;
const COMMAND_DENIAL_FAILURE_CODES = new Set<CommandDenialFailureCode>([
  "bearer_missing",
  "bearer_invalid",
  "lease_expired",
  "scope_resolution_failed",
  "capability_missing",
  "command_scope_denied",
  "identity_required",
  "resource_scope_denied",
]);
const MAX_SAFE_AUDIT_PATH_LENGTH = 512;
const MAX_SAFE_AUDIT_COMMAND_LENGTH = 1_024;

export interface RuntimeCommandDispatcherOptions {
  commands: readonly RegisteredCommand[];
  auditStore?: CommandAuditStore;
  now?: () => Date;
  resolveScope?: CommandScopeResolver;
}

function errorResult(command: CommandName, error: CommandError): CommandResult {
  return {
    ok: false,
    command,
    error,
  };
}

function errorDetails(error: unknown): JsonObject | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  if (error instanceof CommandStructuredError) {
    return error.pandaCommandErrorDetails;
  }

  const commandDetails = (error as {pandaCommandErrorDetails?: unknown}).pandaCommandErrorDetails;
  const details = isJsonObject(commandDetails) ? commandDetails : undefined;
  if ((error as {pandaCommandErrorCode?: unknown}).pandaCommandErrorCode === "rate_limited") {
    if (!details) {
      return undefined;
    }
    const retryAfterMs = details.retryAfterMs;
    const attemptCount = details.attemptCount;
    const totalBackoffMs = details.totalBackoffMs;
    const failureCode = details.failureCode;
    return {
      ...(details.provider === "brave" ? {provider: "brave"} : {}),
      ...(details.status === 429 ? {status: 429} : {}),
      ...(failureCode === "rate_limited" || failureCode === "quota_exhausted" ? {failureCode} : {}),
      ...(typeof details.retryable === "boolean" ? {retryable: details.retryable} : {}),
      ...(typeof retryAfterMs === "number" && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 && retryAfterMs <= MAX_SAFE_RETRY_AFTER_MS
        ? {retryAfterMs}
        : {}),
      ...(typeof attemptCount === "number" && Number.isSafeInteger(attemptCount) && attemptCount >= 0 && attemptCount <= 100
        ? {attemptCount}
        : {}),
      ...(typeof totalBackoffMs === "number" && Number.isSafeInteger(totalBackoffMs) && totalBackoffMs >= 0 && totalBackoffMs <= 60_000
        ? {totalBackoffMs}
        : {}),
      ...(details.autoRetryExhausted === true ? {autoRetryExhausted: true} : {}),
    };
  }
  const output: JsonObject = {
    ...(error.name ? {name: error.name} : {}),
    ...(details ?? {}),
  };

  return Object.keys(output).length > 0 ? output : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function commandErrorCode(error: unknown): CommandErrorCode {
  if (error instanceof CommandStructuredError) {
    return error.pandaCommandErrorCode;
  }
  const code = (error as {pandaCommandErrorCode?: unknown} | null)?.pandaCommandErrorCode;
  return code === "rate_limited" ? code : "command_failed";
}

function safeAuditString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value;
}

function readConflictAuditMetadata(result: CommandResult<JsonValue>, source: JsonObject): CommandAuditMetadata {
  if (result.ok || result.error.code !== "conflict" || source.failureCode !== "stale_version") {
    return {};
  }

  const rawResource = isJsonObject(source.resource) ? source.resource : undefined;
  const path = safeAuditString(rawResource?.path, MAX_SAFE_AUDIT_PATH_LENGTH);
  const locale = safeAuditString(rawResource?.locale, 64);
  const latestUpdatedAt = safeAuditString(rawResource?.latestUpdatedAt, 64);
  const resource = rawResource?.kind === "wiki_page" && path && locale && latestUpdatedAt
    ? {kind: "wiki_page", path, locale, latestUpdatedAt}
    : undefined;

  const rawNextAction = isJsonObject(source.nextAction) ? source.nextAction : undefined;
  const command = safeAuditString(rawNextAction?.command, MAX_SAFE_AUDIT_COMMAND_LENGTH);
  const nextAction = rawNextAction?.kind === "refresh_merge_write" && command?.startsWith("panda wiki read ")
    ? {kind: "refresh_merge_write", command}
    : undefined;

  return {
    failureCode: "stale_version",
    retryable: false,
    ...(source.requiresRefresh === true ? {requiresRefresh: true} : {}),
    ...(resource ? {resource} : {}),
    ...(nextAction ? {nextAction} : {}),
    ...(source.exitCode === 4 ? {exitCode: 4} : {}),
  };
}

function readAuditMetadata(result: CommandResult<JsonValue>): CommandAuditMetadata {
  const source = result.ok
    ? result[COMMAND_AUDIT_METADATA]
    : result.error.details;
  if (!source) {
    return {};
  }
  const attemptCount = source.attemptCount;
  const totalBackoffMs = source.totalBackoffMs;
  const failureCode = source.failureCode;
  const conflictMetadata = result.ok
    ? {}
    : readConflictAuditMetadata(result, result.error.details ?? {});
  const safeFailureCode = typeof failureCode === "string" && (
    failureCode === "rate_limited"
    || failureCode === "quota_exhausted"
    || COMMAND_DENIAL_FAILURE_CODES.has(failureCode as CommandDenialFailureCode)
  )
    ? failureCode
    : conflictMetadata.failureCode;
  return {
    ...(typeof attemptCount === "number" && Number.isSafeInteger(attemptCount) && attemptCount >= 0 && attemptCount <= 100
      ? {attemptCount}
      : {}),
    ...(typeof totalBackoffMs === "number" && Number.isSafeInteger(totalBackoffMs) && totalBackoffMs >= 0 && totalBackoffMs <= 60_000
      ? {totalBackoffMs}
      : {}),
    ...(safeFailureCode ? {failureCode: safeFailureCode} : {}),
    ...(typeof source.retryable === "boolean" ? {retryable: source.retryable} : {}),
    ...(source.autoRetryExhausted === true ? {autoRetryExhausted: true} : {}),
    ...conflictMetadata,
  };
}

function isExpired(scope: CommandScope, now: Date): boolean {
  if (!scope.expiresAt) {
    return false;
  }

  const expiresAt = Date.parse(scope.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now.getTime();
}

export class RuntimeCommandDispatcher implements CommandExecutor {
  private readonly commands = new Map<CommandName, RegisteredCommand>();
  private readonly auditStore?: CommandAuditStore;
  private readonly now: () => Date;
  private readonly resolveScope?: CommandScopeResolver;

  constructor(options: RuntimeCommandDispatcherOptions) {
    this.auditStore = options.auditStore;
    this.now = options.now ?? (() => new Date());
    this.resolveScope = options.resolveScope;
    this.registerCommands(options.commands);
  }

  registerCommands(commands: readonly RegisteredCommand[]): void {
    for (const command of commands) {
      if (this.commands.has(command.descriptor.name)) {
        throw new Error(`Duplicate Panda command ${command.descriptor.name}.`);
      }
      this.commands.set(command.descriptor.name, command);
    }
  }

  async listCommands(scope?: CommandScope): Promise<readonly CommandDescriptor[]> {
    return [...this.commands.values()]
      .filter((command) => isCommandAllowed(scope, command.descriptor.name))
      .map((command) => command.descriptor);
  }

  async getCommand(name: CommandName): Promise<CommandDescriptor | undefined> {
    return this.commands.get(name)?.descriptor;
  }

  async execute<TOutput extends JsonValue = JsonObject>(request: CommandRequest): Promise<CommandResult<TOutput>> {
    let scope: CommandScope;
    try {
      scope = this.resolveScope ? await this.resolveScope(request.scope) : request.scope;
    } catch (error) {
      const denial = error instanceof CommandDenialError
        ? error
        : commandUnauthorized(
          "Panda command scope could not be resolved.",
          "scope_resolution_failed",
          "Command access must be refreshed by the runtime or operator.",
        );
      return errorResult(request.command, denial.toCommandError()) as CommandResult<TOutput>;
    }

    const resolvedRequest: CommandRequest = {
      ...request,
      scope,
    };

    if (isExpired(scope, this.now())) {
      return errorResult(request.command, commandUnauthorized(
        "Panda command lease expired.",
        "lease_expired",
        "Command access must be refreshed by the runtime or operator.",
      ).toCommandError()) as CommandResult<TOutput>;
    }

    const startedAt = this.now().getTime();
    let audit: ThreadToolJobRecord | undefined;
    try {
      audit = await this.startAudit(resolvedRequest, startedAt);
    } catch (error) {
      return errorResult(request.command, {
        code: "command_failed",
        message: `Panda command audit could not be recorded: ${errorMessage(error)}`,
        details: errorDetails(error),
      }) as CommandResult<TOutput>;
    }

    if (!isCommandAllowed(scope, request.command)) {
      const result = errorResult(request.command, commandCapabilityDenied(request.command).toCommandError()) as CommandResult<TOutput>;
      await this.finishAudit(audit, result, startedAt);
      return result;
    }

    const command = this.commands.get(request.command);
    if (!command) {
      const result = errorResult(request.command, {
        code: "unknown_command",
        message: `Unknown Panda command ${request.command}.`,
      }) as CommandResult<TOutput>;
      await this.finishAudit(audit, result, startedAt);
      return result;
    }

    try {
      const result = await command.execute(resolvedRequest) as CommandResult<TOutput>;
      await this.finishAudit(audit, result, startedAt);
      return result;
    } catch (error) {
      const result = errorResult(request.command, {
        code: commandErrorCode(error),
        message: errorMessage(error),
        details: errorDetails(error),
      }) as CommandResult<TOutput>;
      await this.finishAudit(audit, result, startedAt);
      return result;
    }
  }

  private async startAudit(request: CommandRequest, startedAt: number): Promise<ThreadToolJobRecord | undefined> {
    if (!this.auditStore || !request.scope.threadId) {
      return undefined;
    }

    return this.auditStore.createToolJob({
      id: randomUUID(),
      threadId: request.scope.threadId,
      runId: request.scope.runId,
      parentToolCallId: request.scope.parentToolCallId,
      kind: "command",
      summary: request.command,
      startedAt,
      progress: {
        command: request.command,
        outputMode: request.outputMode ?? "json",
        dryRun: request.dryRun === true,
        ...(request.scope.environmentId ? {environmentId: request.scope.environmentId} : {}),
      },
    });
  }

  private async finishAudit(
    audit: ThreadToolJobRecord | undefined,
    result: CommandResult<JsonValue>,
    startedAt: number,
  ): Promise<void> {
    if (!audit || !this.auditStore) {
      return;
    }

    const finishedAt = this.now().getTime();
    try {
      const auditMetadata = readAuditMetadata(result);
      await this.auditStore.updateToolJob(audit.id, {
        status: result.ok ? "completed" : "failed",
        finishedAt,
        durationMs: Math.max(0, finishedAt - startedAt),
        result: result.ok
          ? {
            command: result.command,
            ok: true,
            ...auditMetadata,
          }
          : {
            command: result.command,
            ok: false,
            code: result.error.code,
            ...auditMetadata,
          },
        error: null,
      });
    } catch {
      // The command already ran; leave the started audit row for orphan/lost-job recovery.
    }
  }
}
