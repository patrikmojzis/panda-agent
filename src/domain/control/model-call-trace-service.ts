import {isJsonObject, type JsonObject, type JsonValue} from "../../lib/json.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {PostgresModelCallTraceStore, type ModelCallTraceListInput} from "../model-call-traces/postgres.js";
import {buildSessionTableNames, type SessionTableNames} from "../sessions/postgres-shared.js";
import {sanitizePromptCacheKey, sanitizeTraceJson, sanitizeTraceRequestJson} from "../model-call-traces/redaction.js";
import type {ModelCallTraceMode, ModelCallTraceRecord, ModelCallTraceStatus} from "../model-call-traces/types.js";
import type {ControlSessionRecord} from "./types.js";

export interface ControlModelCallTraceListInput extends ModelCallTraceListInput {
  status?: ModelCallTraceStatus;
  mode?: ModelCallTraceMode;
}

export interface ControlModelCallSessionMetadata {
  sessionLabel: string;
  sessionDisplayName?: string;
  sessionAlias?: string;
  sessionKind: string;
}

export interface ControlModelCallTraceSummary {
  id: string;
  runId: string | null;
  threadId: string | null;
  sessionId: string | null;
  agentKey: string | null;
  sessionLabel?: string;
  sessionDisplayName?: string;
  sessionAlias?: string;
  sessionKind?: string;
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
  return sanitizeTraceRequestJson({
    ...trace.requestJson,
    ...(Object.hasOwn(trace.requestJson, "promptCacheKey")
      ? {promptCacheKey: sanitizePromptCacheKey(trace.requestJson.promptCacheKey)}
      : {}),
  });
}

function publicJsonValue(value: JsonValue | undefined): JsonValue | null {
  return value === undefined ? null : sanitizeTraceJson(value);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function publicJsonObject(value: JsonObject | undefined): JsonObject | null {
  if (value === undefined) {
    return null;
  }
  const sanitized = sanitizeTraceJson(value);
  return isJsonObject(sanitized) ? sanitized : {};
}

function sessionLabel(metadata: Pick<ControlModelCallSessionMetadata, "sessionAlias" | "sessionDisplayName"> & {id: string}): string {
  return metadata.sessionDisplayName?.trim() || metadata.sessionAlias?.trim() || metadata.id;
}

function publicSessionMetadata(row: Record<string, unknown>): {id: string; metadata: ControlModelCallSessionMetadata} {
  const id = String(row.id);
  const sessionDisplayName = readOptionalString(row.display_name);
  const sessionAlias = readOptionalString(row.alias);
  const sessionKind = readOptionalString(row.kind) ?? "session";
  return {
    id,
    metadata: {
      sessionLabel: sessionLabel({id, sessionDisplayName, sessionAlias}),
      ...(sessionDisplayName ? {sessionDisplayName} : {}),
      ...(sessionAlias ? {sessionAlias} : {}),
      sessionKind,
    },
  };
}

function publicSummary(trace: ModelCallTraceRecord, metadata?: ControlModelCallSessionMetadata): ControlModelCallTraceSummary {
  return {
    id: trace.id,
    runId: trace.runId ?? null,
    threadId: trace.threadId ?? null,
    sessionId: trace.sessionId ?? null,
    agentKey: trace.agentKey ?? null,
    ...(metadata ?? {}),
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
    usage: publicJsonValue(trace.usageJson),
    error: publicJsonObject(trace.errorJson),
    expiresAt: iso(trace.expiresAt),
  };
}

function publicDetail(trace: ModelCallTraceRecord, metadata?: ControlModelCallSessionMetadata): ControlModelCallTraceDetail {
  return {
    ...publicSummary(trace, metadata),
    request: publicRequestJson(trace),
    response: publicJsonValue(trace.responseJson),
  };
}

export class ControlModelCallTraceService {
  private readonly pool: PgQueryable;
  private readonly store: PostgresModelCallTraceStore;
  private readonly sessionTables: SessionTableNames;

  constructor(options: {pool: PgQueryable}) {
    this.pool = options.pool;
    this.store = new PostgresModelCallTraceStore({pool: options.pool});
    this.sessionTables = buildSessionTableNames();
  }

  private assertAdmin(session: ControlSessionRecord): void {
    if (session.role !== "admin") {
      throw new Error("Control model call traces require admin access.");
    }
  }

  private async readSessionMetadata(traces: readonly ModelCallTraceRecord[]): Promise<Map<string, ControlModelCallSessionMetadata>> {
    const sessionIds = Array.from(new Set(
      traces
        .map((trace) => trace.sessionId)
        .filter((value): value is string => typeof value === "string" && value.length > 0),
    ));
    if (sessionIds.length === 0) return new Map();

    const placeholders = sessionIds.map((_, index) => `$${index + 1}`).join(", ");
    const result = await this.pool.query(`
      SELECT id, kind, alias, display_name
      FROM ${this.sessionTables.sessions}
      WHERE id IN (${placeholders})
    `, sessionIds);

    return new Map(
      result.rows.map((row) => {
        const entry = publicSessionMetadata(row as Record<string, unknown>);
        return [entry.id, entry.metadata] as const;
      }),
    );
  }

  async listModelCallTraces(
    session: ControlSessionRecord,
    input: ControlModelCallTraceListInput = {},
  ): Promise<ControlModelCallTraceListResult> {
    this.assertAdmin(session);
    const result = await this.store.listTraces(input);
    const sessionMetadata = await this.readSessionMetadata(result.data);
    return {
      data: result.data.map((trace) => publicSummary(trace, trace.sessionId ? sessionMetadata.get(trace.sessionId) : undefined)),
      meta: result.meta,
    };
  }

  async getModelCallTrace(session: ControlSessionRecord, id: string): Promise<ControlModelCallTraceDetail | null> {
    this.assertAdmin(session);
    const trace = await this.store.getTrace(id);
    if (!trace) return null;
    const sessionMetadata = await this.readSessionMetadata([trace]);
    return publicDetail(trace, trace.sessionId ? sessionMetadata.get(trace.sessionId) : undefined);
  }
}
