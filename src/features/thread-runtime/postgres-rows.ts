import { toMillis, toOrderNumber } from "./postgres-shared.js";
import type {
  ThreadInputDeliveryMode,
  ThreadInputRecord,
  ThreadMessageRecord,
  ThreadRunRecord,
  ThreadRecord,
} from "./types.js";

export function parseThreadRow(row: Record<string, unknown>): ThreadRecord {
  return {
    id: String(row.id),
    identityId: String(row.identity_id),
    agentKey: String(row.agent_key),
    systemPrompt: row.system_prompt === null ? undefined : (row.system_prompt as ThreadRecord["systemPrompt"]),
    maxTurns: row.max_turns === null ? undefined : Number(row.max_turns),
    context: row.context === null ? undefined : (row.context as ThreadRecord["context"]),
    runtimeState: row.runtime_state === null ? undefined : (row.runtime_state as ThreadRecord["runtimeState"]),
    maxInputTokens: row.max_input_tokens === null ? undefined : Number(row.max_input_tokens),
    promptCacheKey: row.prompt_cache_key === null ? undefined : String(row.prompt_cache_key),
    provider: row.provider === null ? undefined : String(row.provider) as ThreadRecord["provider"],
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
