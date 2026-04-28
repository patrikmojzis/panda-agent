import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {ThreadToolJobRecord} from "../../domain/threads/runtime/types.js";
import {readThreadId} from "../../integrations/shell/runtime-context.js";
import {Tool, type ToolOutput} from "../../kernel/agent/tool.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {JsonObject, JsonValue, ToolResultPayload} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";

const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

function readString(details: Record<string, unknown>, key: string): string {
  return typeof details[key] === "string" ? String(details[key]).trim() : "";
}

export function formatBackgroundJobResult(message: ToolResultMessage<JsonValue>): string {
  const details = message.details;
  if (!isRecord(details)) {
    return message.isError ? "Background job failed." : "Background job updated.";
  }

  const status = readString(details, "status") || "unknown";
  const jobId = readString(details, "jobId");
  const summary = readString(details, "summary");
  const error = readString(details, "error");
  const reason = readString(details, "reason");

  return [status, summary, error, reason, jobId ? `job ${jobId}` : ""]
    .filter(Boolean)
    .join("\n");
}

function baseJobDetails(record: ThreadToolJobRecord): JsonObject {
  return {
    jobId: record.id,
    kind: record.kind,
    status: record.status,
    summary: record.summary,
    startedAt: record.startedAt,
    ...(record.finishedAt !== undefined ? {finishedAt: record.finishedAt} : {}),
    ...(record.durationMs !== undefined ? {durationMs: record.durationMs} : {}),
    ...(record.error ? {error: record.error} : {}),
    ...(record.statusReason ? {reason: record.statusReason} : {}),
    ...(record.progress ? {progress: record.progress} : {}),
  };
}

export function buildBackgroundJobPayload(record: ThreadToolJobRecord): JsonObject {
  if (record.kind === "bash" && record.result) {
    return {
      ...record.result,
      ...baseJobDetails(record),
    };
  }

  return {
    ...baseJobDetails(record),
    ...(record.result ? {result: record.result} : {}),
  };
}

function materializedPayload(record: ThreadToolJobRecord): ToolResultPayload | null {
  if (record.status !== "completed" || !isRecord(record.result)) {
    return null;
  }

  const contentText = typeof record.result.contentText === "string"
    ? record.result.contentText
    : null;
  const details = isRecord(record.result.details)
    ? record.result.details as JsonObject
    : null;
  if (!contentText || !details) {
    return null;
  }

  return {
    content: [
      {
        type: "text",
        text: contentText,
      },
    ],
    details: {
      ...details,
      backgroundJob: baseJobDetails(record),
    },
  };
}

export function buildBackgroundJobOutput(record: ThreadToolJobRecord): ToolOutput {
  return materializedPayload(record) ?? buildBackgroundJobPayload(record);
}

export interface BackgroundJobToolOptions {
  service: BackgroundToolJobService;
  defaultWaitTimeoutMs?: number;
}

abstract class BackgroundJobToolBase<
  TSchema extends z.ZodTypeAny,
> extends Tool<TSchema, DefaultAgentSessionContext> {
  protected readonly service: BackgroundToolJobService;

  constructor(options: BackgroundJobToolOptions) {
    super();
    this.service = options.service;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    return formatBackgroundJobResult(message);
  }
}

export class BackgroundJobStatusTool extends BackgroundJobToolBase<typeof BackgroundJobStatusTool.schema> {
  static schema = z.object({
    jobId: z.string().trim().min(1),
  });

  name = "background_job_status";
  description = "Check a background tool job created earlier on the current session thread.";
  schema = BackgroundJobStatusTool.schema;

  async handle(
    args: z.output<typeof BackgroundJobStatusTool.schema>,
    run: RunContext<DefaultAgentSessionContext>,
  ): Promise<ToolOutput> {
    const record = await this.service.status(readThreadId(run.context), args.jobId);
    return buildBackgroundJobOutput(record);
  }
}

export class BackgroundJobWaitTool extends BackgroundJobToolBase<typeof BackgroundJobWaitTool.schema> {
  static schema = z.object({
    jobId: z.string().trim().min(1),
    timeoutMs: z.number().int().min(0).max(300_000).optional(),
  });

  name = "background_job_wait";
  description = "Wait up to timeoutMs for a background tool job from the current session thread, then return its latest state or completed result.";
  schema = BackgroundJobWaitTool.schema;

  private readonly defaultWaitTimeoutMs: number;

  constructor(options: BackgroundJobToolOptions) {
    super(options);
    this.defaultWaitTimeoutMs = options.defaultWaitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
  }

  async handle(
    args: z.output<typeof BackgroundJobWaitTool.schema>,
    run: RunContext<DefaultAgentSessionContext>,
  ): Promise<ToolOutput> {
    const record = await this.service.wait(
      readThreadId(run.context),
      args.jobId,
      args.timeoutMs ?? this.defaultWaitTimeoutMs,
    );
    return buildBackgroundJobOutput(record);
  }
}

export class BackgroundJobCancelTool extends BackgroundJobToolBase<typeof BackgroundJobCancelTool.schema> {
  static schema = z.object({
    jobId: z.string().trim().min(1),
  });

  name = "background_job_cancel";
  description = "Request cancellation of a background tool job from the current session thread and return its updated state.";
  schema = BackgroundJobCancelTool.schema;

  async handle(
    args: z.output<typeof BackgroundJobCancelTool.schema>,
    run: RunContext<DefaultAgentSessionContext>,
  ): Promise<ToolOutput> {
    const record = await this.service.cancel(readThreadId(run.context), args.jobId);
    return buildBackgroundJobOutput(record);
  }
}
