import type {AssistantMessage} from "@earendil-works/pi-ai";

import type {Tool} from "../../kernel/agent/tool.js";
import type {LlmRuntimeRequest} from "../../kernel/agent/runtime.js";
import type {JsonObject, JsonValue} from "../../lib/json.js";

export type ModelCallTraceMode = "complete" | "stream";
export type ModelCallTraceStatus = "completed" | "failed";

export interface ModelCallTraceRecord {
  id: string;
  runId?: string;
  threadId?: string;
  sessionId?: string;
  agentKey?: string;
  turn?: number;
  callIndex?: number;
  provider: string;
  model: string;
  mode: ModelCallTraceMode;
  status: ModelCallTraceStatus;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  promptCacheKey?: string;
  requestJson: JsonObject;
  responseJson?: JsonValue;
  errorJson?: JsonObject;
  usageJson?: JsonValue;
  expiresAt: number;
}

export interface RecordModelCallTraceInput {
  mode: ModelCallTraceMode;
  request: LlmRuntimeRequest;
  tools: readonly Tool[];
  startedAt: number;
  finishedAt: number;
  response?: AssistantMessage;
  error?: unknown;
}

export interface ModelCallTraceRecorder {
  recordModelCallTrace(input: RecordModelCallTraceInput): Promise<void>;
}
