import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {z} from "zod";

import {Tool, type ToolOutput} from "../../../kernel/agent/tool.js";
import {ToolError} from "../../../kernel/agent/exceptions.js";
import type {JsonObject, JsonValue} from "../../../kernel/agent/types.js";
import type {RunContext} from "../../../kernel/agent/run-context.js";
import type {ThreadBashJobRecord} from "../../../domain/threads/runtime/types.js";
import type {BashJobService} from "../../../integrations/shell/bash-job-service.js";
import type {PandaSessionContext} from "../types.js";

function readThreadId(context: PandaSessionContext | undefined): string {
  const threadId = context?.threadId?.trim();
  if (!threadId) {
    throw new ToolError("Background bash jobs require the current Panda session thread.");
  }

  return threadId;
}

function readString(details: Record<string, unknown>, key: string): string {
  return typeof details[key] === "string" ? String(details[key]).trim() : "";
}

export function formatBashJobResult(message: ToolResultMessage<JsonValue>): string {
  const details = message.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return message.isError ? "Background bash job failed." : "Background bash job updated.";
  }

  const status = typeof details.status === "string" ? details.status : "unknown";
  const jobId = typeof details.jobId === "string" ? details.jobId : "";
  const stdout = readString(details, "stdout");
  const stderr = readString(details, "stderr");
  const reason = readString(details, "reason");
  const summary = [stdout, stderr, reason].filter(Boolean).join("\n\n");

  if (summary) {
    return `${status}\n${summary}`;
  }

  if (jobId) {
    return `${status}\njob ${jobId}`;
  }

  return status;
}

export function buildBashJobPayload(record: ThreadBashJobRecord): JsonObject {
  return {
    jobId: record.id,
    status: record.status,
    command: record.command,
    mode: record.mode,
    initialCwd: record.initialCwd,
    startedAt: record.startedAt,
    timedOut: record.timedOut,
    stdout: record.stdout,
    stderr: record.stderr,
    stdoutChars: record.stdoutChars,
    stderrChars: record.stderrChars,
    stdoutTruncated: record.stdoutTruncated,
    stderrTruncated: record.stderrTruncated,
    stdoutPersisted: record.stdoutPersisted,
    stderrPersisted: record.stderrPersisted,
    trackedEnvKeys: record.trackedEnvKeys,
    sessionStateIsolated: true,
    ...(record.finalCwd ? { finalCwd: record.finalCwd } : {}),
    ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
    ...(record.durationMs !== undefined ? { durationMs: record.durationMs } : {}),
    ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
    ...(record.signal !== undefined ? { signal: record.signal } : {}),
    ...(record.stdoutPath ? { stdoutPath: record.stdoutPath } : {}),
    ...(record.stderrPath ? { stderrPath: record.stderrPath } : {}),
    ...(record.statusReason ? { reason: record.statusReason } : {}),
  };
}

export interface BashJobToolOptions {
  service: BashJobService;
  defaultWaitTimeoutMs?: number;
}

abstract class BashJobToolBase<
  TSchema extends z.ZodTypeAny,
> extends Tool<TSchema, PandaSessionContext> {
  protected readonly service: BashJobService;

  constructor(options: BashJobToolOptions) {
    super();
    this.service = options.service;
  }

  override formatResult(message: ToolResultMessage<JsonValue>): string {
    return formatBashJobResult(message);
  }
}

export class BashJobStatusTool extends BashJobToolBase<typeof BashJobStatusTool.schema> {
  static schema = z.object({
    jobId: z.string().trim().min(1),
  });

  name = "bash_job_status";
  description = "Check the current state of a background bash job created earlier on the current session thread.";
  schema = BashJobStatusTool.schema;

  async handle(
    args: z.output<typeof BashJobStatusTool.schema>,
    run: RunContext<PandaSessionContext>,
  ): Promise<ToolOutput> {
    const record = await this.service.status(readThreadId(run.context), args.jobId);
    return buildBashJobPayload(record);
  }
}

export class BashJobWaitTool extends BashJobToolBase<typeof BashJobWaitTool.schema> {
  static schema = z.object({
    jobId: z.string().trim().min(1),
    timeoutMs: z.number().int().min(0).max(300_000).optional(),
  });

  name = "bash_job_wait";
  description = "Wait up to timeoutMs for a background bash job from the current session thread to finish, then return its latest state.";
  schema = BashJobWaitTool.schema;

  private readonly defaultWaitTimeoutMs: number;

  constructor(options: BashJobToolOptions) {
    super(options);
    this.defaultWaitTimeoutMs = options.defaultWaitTimeoutMs ?? 15_000;
  }

  async handle(
    args: z.output<typeof BashJobWaitTool.schema>,
    run: RunContext<PandaSessionContext>,
  ): Promise<ToolOutput> {
    const record = await this.service.wait(
      readThreadId(run.context),
      args.jobId,
      args.timeoutMs ?? this.defaultWaitTimeoutMs,
    );
    return buildBashJobPayload(record);
  }
}

export class BashJobCancelTool extends BashJobToolBase<typeof BashJobCancelTool.schema> {
  static schema = z.object({
    jobId: z.string().trim().min(1),
  });

  name = "bash_job_cancel";
  description = "Request cancellation of a background bash job from the current session thread and return its updated state.";
  schema = BashJobCancelTool.schema;

  async handle(
    args: z.output<typeof BashJobCancelTool.schema>,
    run: RunContext<PandaSessionContext>,
  ): Promise<ToolOutput> {
    const record = await this.service.cancel(readThreadId(run.context), args.jobId);
    return buildBashJobPayload(record);
  }
}
