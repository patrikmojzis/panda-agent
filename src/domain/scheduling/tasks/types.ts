import type {JsonObject} from "../../../kernel/agent/types.js";
import {isRecord} from "../../../lib/records.js";

export type ScheduledTaskScheduleKind = "once" | "recurring";
export type ScheduledTaskFireKind = "execute" | "deliver";
export type ScheduledTaskRunStatus = "claimed" | "running" | "succeeded" | "failed" | "cancelled";
export type ScheduledTaskDeliveryStatus = "not_requested" | "sent" | "unavailable" | "failed";

export interface ScheduledTaskOnceSchedule {
  kind: "once";
  runAt: string;
  deliverAt?: string;
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
  title: string;
  instruction: string;
  schedule: ScheduledTaskSchedule;
  enabled: boolean;
  nextFireAt?: number;
  nextFireKind: ScheduledTaskFireKind;
  claimedAt?: number;
  claimedBy?: string;
  claimExpiresAt?: number;
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
  fireKind: ScheduledTaskFireKind;
  scheduledFor: number;
  status: ScheduledTaskRunStatus;
  threadRunId?: string;
  deliveryStatus: ScheduledTaskDeliveryStatus;
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface CreateScheduledTaskInput {
  sessionId: string;
  createdByIdentityId?: string;
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

export interface ClaimScheduledTaskInput {
  taskId: string;
  claimedBy: string;
  claimExpiresAt: number;
  nextFireAt?: number;
}

export interface ClaimScheduledTaskResult {
  task: ScheduledTaskRecord;
  run: ScheduledTaskRunRecord;
}

export interface StartScheduledTaskRunInput {
  runId: string;
  resolvedThreadId?: string;
}

export interface CompleteScheduledTaskRunInput {
  runId: string;
  resolvedThreadId?: string;
  threadRunId?: string;
  deliveryStatus?: ScheduledTaskDeliveryStatus;
}

export interface FailScheduledTaskRunInput {
  runId: string;
  resolvedThreadId?: string;
  threadRunId?: string;
  deliveryStatus?: ScheduledTaskDeliveryStatus;
  error: string;
}

export interface ScheduledTaskThreadInputMetadataValue extends JsonObject {
  taskId: string;
  title: string;
  phase: ScheduledTaskFireKind;
  deliveryMode: "immediate" | "deferred";
  runAt: string;
  deliverAt: string | null;
}

export interface ScheduledTaskThreadInputMetadata extends JsonObject {
  scheduledTask: ScheduledTaskThreadInputMetadataValue;
}

export function parseScheduledTaskThreadInputMetadata(value: unknown): ScheduledTaskThreadInputMetadata | null {
  if (!isRecord(value)) {
    return null;
  }

  const candidate = value.scheduledTask;
  if (!isRecord(candidate)) {
    return null;
  }

  if (
    typeof candidate.taskId !== "string"
    || typeof candidate.title !== "string"
    || (candidate.phase !== "execute" && candidate.phase !== "deliver")
    || (candidate.deliveryMode !== "immediate" && candidate.deliveryMode !== "deferred")
    || typeof candidate.runAt !== "string"
  ) {
    return null;
  }

  return {
    scheduledTask: {
      taskId: candidate.taskId,
      title: candidate.title,
      phase: candidate.phase,
      deliveryMode: candidate.deliveryMode,
      runAt: candidate.runAt,
      deliverAt: typeof candidate.deliverAt === "string" ? candidate.deliverAt : null,
    },
  };
}
