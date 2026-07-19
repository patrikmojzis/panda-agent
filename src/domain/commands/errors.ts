import type {JsonObject} from "../../lib/json.js";
import type {CommandError, CommandErrorCode, CommandName} from "./types.js";

export const COMMAND_DENIAL_EXIT_CODE = 3;
export const COMMAND_CONFLICT_EXIT_CODE = 4;
export const COMMAND_DISCOVERY_INSTRUCTION = "panda commands --output json";

export type CommandDenialCode = Extract<CommandErrorCode, "unauthorized" | "forbidden">;

export type CommandDenialFailureCode =
  | "bearer_missing"
  | "bearer_invalid"
  | "lease_expired"
  | "scope_resolution_failed"
  | "capability_missing"
  | "command_scope_denied"
  | "identity_required"
  | "resource_scope_denied";

export type CommandDenialNextAction =
  | {kind: "discover_capabilities"; command: typeof COMMAND_DISCOVERY_INSTRUCTION}
  | {kind: "stop"; reason: string};

export interface CommandDenialErrorOptions {
  code: CommandDenialCode;
  failureCode: CommandDenialFailureCode;
  message: string;
  nextAction: CommandDenialNextAction;
  requiredCapability?: CommandName;
}

/** Typed command failure whose normalized fields are safe to preserve across command transports. */
export class CommandStructuredError extends Error {
  constructor(
    readonly pandaCommandErrorCode: CommandErrorCode,
    message: string,
    readonly pandaCommandErrorDetails: JsonObject,
  ) {
    super(message);
    this.name = "CommandStructuredError";
  }

  toCommandError(): CommandError {
    return {
      code: this.pandaCommandErrorCode,
      message: this.message,
      details: this.pandaCommandErrorDetails,
    };
  }
}

/** Terminal command authority failure that is safe to expose through transports and audits. */
export class CommandDenialError extends CommandStructuredError {

  constructor(readonly options: CommandDenialErrorOptions) {
    super(options.code, options.message, {
      failureCode: options.failureCode,
      retryable: false,
      nextAction: options.nextAction,
      exitCode: COMMAND_DENIAL_EXIT_CODE,
      ...(options.requiredCapability ? {requiredCapability: options.requiredCapability} : {}),
    });
    this.name = "CommandDenialError";
  }
}

export interface CommandConflictResource {
  kind: string;
  id?: string | number;
  path?: string;
  locale?: string;
  latestUpdatedAt?: string;
  latestRevision?: string | number;
}

export interface CommandConflictErrorOptions {
  message: string;
  resource: CommandConflictResource;
  nextAction: {
    kind: "refresh_merge_write";
    command: string;
  };
}

/** Stale optimistic write that requires fresh state before another mutation. */
export class CommandConflictError extends CommandStructuredError {
  constructor(options: CommandConflictErrorOptions) {
    super("conflict", options.message, {
      failureCode: "stale_version",
      retryable: false,
      requiresRefresh: true,
      resource: {
        kind: options.resource.kind,
        ...(options.resource.id === undefined ? {} : {id: options.resource.id}),
        ...(options.resource.path === undefined ? {} : {path: options.resource.path}),
        ...(options.resource.locale === undefined ? {} : {locale: options.resource.locale}),
        ...(options.resource.latestUpdatedAt === undefined ? {} : {latestUpdatedAt: options.resource.latestUpdatedAt}),
        ...(options.resource.latestRevision === undefined ? {} : {latestRevision: options.resource.latestRevision}),
      },
      nextAction: {
        kind: options.nextAction.kind,
        command: options.nextAction.command,
      },
      exitCode: COMMAND_CONFLICT_EXIT_CODE,
    });
    this.name = "CommandConflictError";
  }
}

/** Creates the canonical stale-version failure without performing a retry or merge. */
export function commandStaleVersionConflict(options: CommandConflictErrorOptions): CommandConflictError {
  return new CommandConflictError(options);
}

/** Creates the canonical terminal failure for a command missing from the authenticated lease. */
export function commandCapabilityDenied(command: CommandName): CommandDenialError {
  return new CommandDenialError({
    code: "forbidden",
    failureCode: "capability_missing",
    message: `Panda command ${command} is not allowed in this session.`,
    requiredCapability: command,
    nextAction: {
      kind: "discover_capabilities",
      command: COMMAND_DISCOVERY_INSTRUCTION,
    },
  });
}

/** Creates a terminal command-scope denial without exposing private authority state. */
export function commandScopeDenied(
  message: string,
  failureCode: Extract<CommandDenialFailureCode, "command_scope_denied" | "identity_required" | "resource_scope_denied">,
  reason: string,
): CommandDenialError {
  return new CommandDenialError({
    code: "forbidden",
    failureCode,
    message,
    nextAction: {kind: "stop", reason},
  });
}

/** Creates a terminal command authentication failure with no retry or bypass guidance. */
export function commandUnauthorized(
  message: string,
  failureCode: Extract<CommandDenialFailureCode, "bearer_missing" | "bearer_invalid" | "lease_expired" | "scope_resolution_failed">,
  reason: string,
): CommandDenialError {
  return new CommandDenialError({
    code: "unauthorized",
    failureCode,
    message,
    nextAction: {kind: "stop", reason},
  });
}
