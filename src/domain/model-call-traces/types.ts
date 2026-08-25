import type {JsonObject, JsonValue} from "../../lib/json.js";

export type ModelCallTraceMode = "complete" | "stream";
export type ModelCallTraceStatus = "completed" | "failed";
export type ModelCallSnapshotStatus = "not_captured" | "captured" | "truncated" | "dropped";

export interface ModelCallUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
}

export interface ModelCallFailure {
  category: string;
  message: string;
  provider?: string;
  model?: string;
  status?: number;
  retryable?: boolean;
  timedOut?: boolean;
  stopReason?: string;
}

export interface ModelCallRequestShape {
  systemPromptChars: number;
  messageCount: number;
  toolCount: number;
  contextSectionCount: number;
  contextChars: number;
}

export interface ModelCallSnapshotRecord {
  requestJson: JsonObject;
  responseJson?: JsonValue;
  bytes: number;
  truncated: boolean;
  expiresAt: number;
}

/** Narrow, query-friendly facts for one provider attempt. */
export interface ModelCallAttemptRecord {
  id: string;
  runId?: string;
  threadId?: string;
  sessionId?: string;
  agentKey?: string;
  turn?: number;
  attempt: number;
  provider: string;
  model: string;
  mode: ModelCallTraceMode;
  status: ModelCallTraceStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  promptCacheKey?: string;
  usage?: ModelCallUsage;
  failure?: ModelCallFailure;
  requestShape: ModelCallRequestShape;
  snapshotStatus: ModelCallSnapshotStatus;
  snapshot?: ModelCallSnapshotRecord;
  expiresAt: number;
}

/** Fully prepared write owned by the background recorder, never by the agent loop. */
export type ModelCallAttemptWrite = ModelCallAttemptRecord;
