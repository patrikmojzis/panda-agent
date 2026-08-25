import type {JsonObject} from "../../../lib/json.js";

export type ScheduledTaskScheduleKind = "once" | "recurring";
export type ScheduledTaskRunStatus = "pending" | "claimed" | "running" | "succeeded" | "failed" | "cancelled";

export interface ScheduledTaskOnceSchedule {
  kind: "once";
  runAt: string;
}

export interface ScheduledTaskRecurringSchedule {
  kind: "recurring";
  cron: string;
  timezone: string;
}

export type ScheduledTaskSchedule =
  | ScheduledTaskOnceSchedule
  | ScheduledTaskRecurringSchedule;

export interface ScheduledTaskRecord {
  id: string;
  sessionId: string;
  createdByIdentityId?: string;
  createdFromMessageId?: string;
  title: string;
  instruction: string;
  schedule: ScheduledTaskSchedule;
  enabled: boolean;
  nextFireAt?: number;
  completedAt?: number;
  cancelledAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduledTaskRunRecord {
  id: string;
  taskId: string;
  sessionId: string;
  createdByIdentityId?: string;
  resolvedThreadId?: string;
  scheduledFor: number;
  status: ScheduledTaskRunStatus;
  threadInputId?: string;
  threadRunId?: string;
  claimToken?: string;
  claimedAt?: number;
  claimedBy?: string;
  claimExpiresAt?: number;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface ClaimedScheduledTaskRunRecord extends ScheduledTaskRunRecord {
  claimToken: string;
  claimedAt: number;
  claimedBy: string;
  claimExpiresAt: number;
}

export interface CreateScheduledTaskInput {
  sessionId: string;
  createdByIdentityId?: string;
  createdFromMessageId?: string;
  title: string;
  instruction: string;
  schedule: ScheduledTaskSchedule;
  enabled?: boolean;
}

export interface UpdateScheduledTaskInput {
  taskId: string;
  sessionId: string;
  title?: string;
  instruction?: string;
  schedule?: ScheduledTaskSchedule;
  enabled?: boolean;
}

export interface CancelScheduledTaskInput {
  taskId: string;
  sessionId: string;
  reason?: string;
}

export interface ListDueScheduledTasksInput {
  asOf?: number;
  limit?: number;
}

export interface ListActiveScheduledTasksInput {
  sessionId: string;
  limit?: number;
}

export type ListScheduledTasksStatus =
  | "active"
  | "disabled"
  | "completed"
  | "cancelled"
  | "all";

export interface ListScheduledTasksInput {
  sessionId: string;
  status?: ListScheduledTasksStatus;
  limit?: number;
}

export interface ListScheduledTaskRunsInput {
  taskId: string;
  sessionId: string;
  limit?: number;
}

export interface MaterializeScheduledTaskRunInput {
  taskId: string;
  scheduledFor: number;
  nextFireAt?: number;
}

export interface MaterializeScheduledTaskRunsInput {
  runs: readonly MaterializeScheduledTaskRunInput[];
}

export interface ClaimScheduledTaskRunInput {
  claimedBy: string;
  claimTtlMs: number;
}

export interface ClaimScheduledTaskResult {
  task: ScheduledTaskRecord;
  run: ClaimedScheduledTaskRunRecord;
}

export interface StartScheduledTaskRunInput {
  runId: string;
  claimToken: string;
}

export interface RenewScheduledTaskRunClaimInput {
  runId: string;
  claimToken: string;
  claimTtlMs: number;
}

export interface CompleteScheduledTaskRunInput {
  runId: string;
  claimToken: string;
  threadRunId: string;
}

export interface FailScheduledTaskRunInput {
  runId: string;
  claimToken: string;
  threadRunId?: string;
  error: string;
}

export interface ScheduledTaskThreadInputMetadataValue extends JsonObject {
  taskId: string;
  taskRunId: string;
  title: string;
  runAt: string;
}

export interface ScheduledTaskThreadInputMetadata extends JsonObject {
  scheduledTask: ScheduledTaskThreadInputMetadataValue;
}
