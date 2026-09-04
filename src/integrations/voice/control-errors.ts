import {CommandStructuredError} from "../../domain/commands/errors.js";

/** A local waiter reached its deadline while its durable control remains unfinished. */
export class VoiceControlWaitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceControlWaitTimeoutError";
  }
}

/** Keeps an unreadable control/turn distinct from a deadline without exposing store errors. */
export function voiceStateUnavailable(cause: unknown, controlId?: string): CommandStructuredError {
  const error = new CommandStructuredError("command_failed", "Live voice state could not be read.", {
    failureCode: "voice_state_unavailable",
    retryable: false,
    ...(controlId ? {controlId} : {}),
  });
  error.cause = cause;
  return error;
}
