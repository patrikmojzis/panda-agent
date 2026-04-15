import {toMillis, toOrderNumber} from "./postgres-shared.js";
import type {
    ThreadBashJobRecord,
    ThreadInputDeliveryMode,
    ThreadInputRecord,
    ThreadMessageRecord,
    ThreadRecord,
    ThreadRunRecord,
} from "./types.js";

export function parseThreadRow(row: Record<string, unknown>): ThreadRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    systemPrompt: row.system_prompt === null ? undefined : (row.system_prompt as ThreadRecord["systemPrompt"]),
    maxTurns: row.max_turns === null ? undefined : Number(row.max_turns),
    context: row.context === null ? undefined : (row.context as ThreadRecord["context"]),
    runtimeState: row.runtime_state === null ? undefined : (row.runtime_state as ThreadRecord["runtimeState"]),
    inferenceProjection: row.inference_projection === null ? undefined : (row.inference_projection as ThreadRecord["inferenceProjection"]),
    maxInputTokens: row.max_input_tokens === null ? undefined : Number(row.max_input_tokens),
    promptCacheKey: row.prompt_cache_key === null ? undefined : String(row.prompt_cache_key),
    model: row.model === null ? undefined : String(row.model),
    temperature: row.temperature === null ? undefined : Number(row.temperature),
    thinking: row.thinking === null ? undefined : String(row.thinking) as ThreadRecord["thinking"],
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export function parseMessageRow(row: Record<string, unknown>): ThreadMessageRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    sequence: toOrderNumber(row.sequence),
    origin: String(row.origin) as ThreadMessageRecord["origin"],
    message: row.message as ThreadMessageRecord["message"],
    metadata: row.metadata === null ? undefined : (row.metadata as ThreadMessageRecord["metadata"]),
    source: String(row.source),
    channelId: row.channel_id === null ? undefined : String(row.channel_id),
    externalMessageId: row.external_message_id === null ? undefined : String(row.external_message_id),
    actorId: row.actor_id === null ? undefined : String(row.actor_id),
    identityId: row.identity_id === null ? undefined : String(row.identity_id),
    runId: row.run_id === null ? undefined : String(row.run_id),
    createdAt: toMillis(row.created_at),
  };
}

export function parseInputRow(row: Record<string, unknown>): ThreadInputRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    order: toOrderNumber(row.input_order),
    deliveryMode: String(row.delivery_mode) as ThreadInputDeliveryMode,
    message: row.message as ThreadInputRecord["message"],
    metadata: row.metadata === null ? undefined : (row.metadata as ThreadInputRecord["metadata"]),
    source: String(row.source),
    channelId: row.channel_id === null ? undefined : String(row.channel_id),
    externalMessageId: row.external_message_id === null ? undefined : String(row.external_message_id),
    actorId: row.actor_id === null ? undefined : String(row.actor_id),
    identityId: row.identity_id === null ? undefined : String(row.identity_id),
    createdAt: toMillis(row.created_at),
    appliedAt: row.applied_at === null ? undefined : toMillis(row.applied_at),
  };
}

export function parseRunRow(row: Record<string, unknown>): ThreadRunRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    status: String(row.status) as ThreadRunRecord["status"],
    startedAt: toMillis(row.started_at),
    finishedAt: row.finished_at === null ? undefined : toMillis(row.finished_at),
    error: row.error === null ? undefined : String(row.error),
    abortRequestedAt: row.abort_requested_at === null ? undefined : toMillis(row.abort_requested_at),
    abortReason: row.abort_reason === null ? undefined : String(row.abort_reason),
  };
}

export function parseBashJobRow(row: Record<string, unknown>): ThreadBashJobRecord {
  return {
    id: String(row.id),
    threadId: String(row.thread_id),
    runId: row.run_id === null ? undefined : String(row.run_id),
    status: String(row.status) as ThreadBashJobRecord["status"],
    command: String(row.command),
    mode: String(row.mode) as ThreadBashJobRecord["mode"],
    initialCwd: String(row.initial_cwd),
    finalCwd: row.final_cwd === null ? undefined : String(row.final_cwd),
    startedAt: toMillis(row.started_at),
    finishedAt: row.finished_at === null ? undefined : toMillis(row.finished_at),
    durationMs: row.duration_ms === null ? undefined : Number(row.duration_ms),
    exitCode: row.exit_code === null ? undefined : Number(row.exit_code),
    signal: row.signal === null ? undefined : String(row.signal) as NodeJS.Signals,
    timedOut: Boolean(row.timed_out),
    stdout: row.stdout === null ? "" : String(row.stdout),
    stderr: row.stderr === null ? "" : String(row.stderr),
    stdoutChars: Number(row.stdout_chars ?? 0),
    stderrChars: Number(row.stderr_chars ?? 0),
    stdoutTruncated: Boolean(row.stdout_truncated),
    stderrTruncated: Boolean(row.stderr_truncated),
    stdoutPersisted: Boolean(row.stdout_persisted),
    stderrPersisted: Boolean(row.stderr_persisted),
    stdoutPath: row.stdout_path === null ? undefined : String(row.stdout_path),
    stderrPath: row.stderr_path === null ? undefined : String(row.stderr_path),
    trackedEnvKeys: Array.isArray(row.tracked_env_keys)
      ? row.tracked_env_keys.filter((entry): entry is string => typeof entry === "string")
      : [],
    statusReason: row.status_reason === null ? undefined : String(row.status_reason),
  };
}
