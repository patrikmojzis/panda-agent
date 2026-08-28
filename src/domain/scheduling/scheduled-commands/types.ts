export type ScheduledCommandRunTrigger = "schedule" | "manual";
export type ScheduledCommandRunStatus = "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";
export type ScheduledCommandNotificationKind = "failure" | "recovery";

export interface ScheduledCommandDefinition {
  commandId: string;
  sessionId: string;
  version: number;
  title: string;
  command: string;
  cwd?: string;
  cron: string;
  timezone: string;
  credentialNames: readonly string[];
  timeoutMs: number;
  enabled: boolean;
  keyId: string;
  integrityTag: string;
  createdAt: number;
}

export interface ScheduledCommandRecord extends ScheduledCommandDefinition {
  createdByIdentityId?: string;
  createdFromMessageId?: string;
  nextFireAt?: number;
  blockedAt?: number;
  blockedReason?: string;
  consecutiveFailures: number;
  lastFailureCode?: string;
  lastNotifiedFailureCode?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledCommandRunRecord {
  id: string;
  commandId: string;
  sessionId: string;
  version: number;
  trigger: ScheduledCommandRunTrigger;
  scheduledFor: number;
  status: ScheduledCommandRunStatus;
  claimToken?: string;
  claimedAt?: number;
  claimedBy?: string;
  claimExpiresAt?: number;
  resolvedEnvironmentId?: string;
  resolvedCwd?: string;
  exitCode?: number;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  failureCode?: string;
  error?: string;
  notificationKind?: ScheduledCommandNotificationKind;
  notifiedAt?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface ClaimedScheduledCommandRun extends ScheduledCommandRunRecord {
  claimToken: string;
  claimedAt: number;
  claimedBy: string;
  claimExpiresAt: number;
}

export interface ClaimedScheduledCommand {
  command: ScheduledCommandRecord;
  run: ClaimedScheduledCommandRun;
}

export interface CreateScheduledCommandInput {
  id: string;
  sessionId: string;
  createdByIdentityId?: string;
  createdFromMessageId?: string;
  definition: Omit<ScheduledCommandDefinition, "commandId" | "sessionId" | "version" | "createdAt">;
  nextFireAt?: number;
}

export interface ReplaceScheduledCommandVersionInput {
  commandId: string;
  sessionId: string;
  expectedVersion: number;
  definition: Omit<ScheduledCommandDefinition, "commandId" | "sessionId" | "version" | "createdAt">;
  nextFireAt?: number;
}

export type ScheduledCommandListStatus = "active" | "disabled" | "blocked" | "all";

export interface ScheduledCommandExecutionResult {
  resolvedEnvironmentId: string;
  resolvedCwd: string;
  exitCode?: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface SettleScheduledCommandRunInput {
  runId: string;
  claimToken: string;
  status: "succeeded" | "failed";
  result?: ScheduledCommandExecutionResult;
  failureCode?: string;
  error?: string;
}
