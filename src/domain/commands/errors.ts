import type {JsonObject} from "../../lib/json.js";
import type {CommandError, CommandErrorCode, CommandName} from "./types.js";

export const COMMAND_DENIAL_EXIT_CODE = 3;
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

/** Terminal command authority failure that is safe to expose through transports and audits. */
export class CommandDenialError extends Error {
  readonly pandaCommandErrorCode: CommandDenialCode;
  readonly pandaCommandErrorDetails: JsonObject;

  constructor(readonly options: CommandDenialErrorOptions) {
    super(options.message);
    this.name = "CommandDenialError";
    this.pandaCommandErrorCode = options.code;
    this.pandaCommandErrorDetails = {
      failureCode: options.failureCode,
      retryable: false,
      nextAction: options.nextAction,
      exitCode: COMMAND_DENIAL_EXIT_CODE,
      ...(options.requiredCapability ? {requiredCapability: options.requiredCapability} : {}),
    };
  }

  toCommandError(): CommandError {
    return {
      code: this.options.code,
      message: this.message,
      details: this.pandaCommandErrorDetails,
    };
  }
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
