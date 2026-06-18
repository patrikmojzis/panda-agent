import type {JsonObject, JsonValue} from "../../lib/json.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {PostgresModelCallTraceStore, type ModelCallTraceListInput} from "../model-call-traces/postgres.js";
import {sanitizePromptCacheKey} from "../model-call-traces/redaction.js";
import type {ModelCallTraceMode, ModelCallTraceRecord, ModelCallTraceStatus} from "../model-call-traces/types.js";
import type {ControlSessionRecord} from "./types.js";

export interface ControlModelCallTraceListInput extends ModelCallTraceListInput {
  status?: ModelCallTraceStatus;
  mode?: ModelCallTraceMode;
}

export interface ControlModelCallTraceSummary {
  id: string;
  runId: string | null;
  threadId: string | null;
  sessionId: string | null;
  agentKey: string | null;
  turn: number | null;
  callIndex: number | null;
  provider: string;
  model: string;
  mode: ModelCallTraceMode;
  status: ModelCallTraceStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  promptCacheKey: string | null;
  usage: JsonValue | null;
  error: JsonObject | null;
  expiresAt: string;
}

export interface ControlModelCallTraceDetail extends ControlModelCallTraceSummary {
  request: JsonObject;
  response: JsonValue | null;
}

export interface ControlModelCallTraceListResult {
  data: readonly ControlModelCallTraceSummary[];
  meta: {
    current_page: number;
    last_page: number;
    per_page: number;
    total: number;
  };
}

function iso(value: number): string {
  return new Date(value).toISOString();
}

function publicPromptCacheKey(value: string | undefined): string | null {
  return value === undefined ? null : sanitizePromptCacheKey(value);
}

function publicRequestJson(trace: ModelCallTraceRecord): JsonObject {
  if (!Object.hasOwn(trace.requestJson, "promptCacheKey")) {
    return trace.requestJson;
  }
  return {
    ...trace.requestJson,
    promptCacheKey: sanitizePromptCacheKey(trace.requestJson.promptCacheKey),
  };
}

function publicSummary(trace: ModelCallTraceRecord): ControlModelCallTraceSummary {
  return {
    id: trace.id,
    runId: trace.runId ?? null,
    threadId: trace.threadId ?? null,
    sessionId: trace.sessionId ?? null,
    agentKey: trace.agentKey ?? null,
    turn: trace.turn ?? null,
    callIndex: trace.callIndex ?? null,
    provider: trace.provider,
    model: trace.model,
    mode: trace.mode,
    status: trace.status,
    startedAt: iso(trace.startedAt),
    finishedAt: iso(trace.finishedAt),
    durationMs: trace.durationMs,
    promptCacheKey: publicPromptCacheKey(trace.promptCacheKey),
    usage: trace.usageJson ?? null,
    error: trace.errorJson ?? null,
    expiresAt: iso(trace.expiresAt),
  };
}

function publicDetail(trace: ModelCallTraceRecord): ControlModelCallTraceDetail {
  return {
    ...publicSummary(trace),
    request: publicRequestJson(trace),
    response: trace.responseJson ?? null,
  };
}

export class ControlModelCallTraceService {
  private readonly store: PostgresModelCallTraceStore;

  constructor(options: {pool: PgQueryable}) {
    this.store = new PostgresModelCallTraceStore({pool: options.pool});
  }

  private assertAdmin(session: ControlSessionRecord): void {
    if (session.role !== "admin") {
      throw new Error("Control model call traces require admin access.");
    }
  }

  async listModelCallTraces(
    session: ControlSessionRecord,
    input: ControlModelCallTraceListInput = {},
  ): Promise<ControlModelCallTraceListResult> {
    this.assertAdmin(session);
    const result = await this.store.listTraces(input);
    return {
      data: result.data.map(publicSummary),
      meta: result.meta,
    };
  }

  async getModelCallTrace(session: ControlSessionRecord, id: string): Promise<ControlModelCallTraceDetail | null> {
    this.assertAdmin(session);
    const trace = await this.store.getTrace(id);
    return trace ? publicDetail(trace) : null;
  }
}
