import type {
  ClaimedScheduledCommand,
  CreateScheduledCommandInput,
  ReplaceScheduledCommandVersionInput,
  ScheduledCommandListStatus,
  ScheduledCommandRecord,
  ScheduledCommandRunRecord,
  SettleScheduledCommandRunInput,
} from "./types.js";

/** Locked store state no longer matches the caller's optimistic command version. */
export class ScheduledCommandVersionConflictError extends Error {
  constructor(
    readonly commandId: string,
    readonly currentVersion: number,
  ) {
    super(`Scheduled command ${commandId} is version ${currentVersion}.`);
    this.name = "ScheduledCommandVersionConflictError";
  }
}

export interface ScheduledCommandStore {
  createCommand(input: CreateScheduledCommandInput): Promise<ScheduledCommandRecord>;
  replaceVersion(input: ReplaceScheduledCommandVersionInput): Promise<ScheduledCommandRecord>;
  deleteCommand(input: {commandId: string; sessionId: string; expectedVersion: number}): Promise<boolean>;
  getCommand(commandId: string): Promise<ScheduledCommandRecord>;
  listCommands(input: {sessionId: string; status?: ScheduledCommandListStatus; limit?: number}): Promise<readonly ScheduledCommandRecord[]>;
  listRuns(input: {commandId: string; sessionId: string; limit?: number}): Promise<readonly ScheduledCommandRunRecord[]>;
  enqueueManualRun(input: {commandId: string; sessionId: string; expectedVersion: number}): Promise<ScheduledCommandRunRecord>;
  listDueCommands(input?: {limit?: number}): Promise<readonly ScheduledCommandRecord[]>;
  materializeScheduledRun(input: {commandId: string; scheduledFor: number; nextFireAt: number}): Promise<ScheduledCommandRunRecord | null>;
  claimRun(input: {claimedBy: string; claimTtlMs: number}): Promise<ClaimedScheduledCommand | null>;
  renewRunClaim(input: {runId: string; claimToken: string; claimTtlMs: number}): Promise<ScheduledCommandRunRecord | null>;
  startRun(input: {runId: string; claimToken: string; environmentId: string; cwd: string}): Promise<ScheduledCommandRunRecord>;
  settleRun(input: SettleScheduledCommandRunInput): Promise<ScheduledCommandRunRecord>;
  markIntegrityViolation(input: {runId: string; claimToken: string; reason: string}): Promise<ScheduledCommandRunRecord>;
  completeNotification(input: {runId: string; claimToken: string}): Promise<ScheduledCommandRunRecord>;
}
