import {randomUUID} from "node:crypto";

import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {isJsonObject, isJsonValue, type JsonObject, type JsonValue} from "../../lib/json.js";
import {ensurePostgresModelCallTraceSchema} from "./postgres-schema.js";
import {buildModelCallTraceTableNames, type ModelCallTraceTableNames} from "./postgres-shared.js";
import {buildSanitizedModelCallTrace, sanitizePromptCacheKey} from "./redaction.js";
import type {ModelCallTraceMode, ModelCallTraceRecord, ModelCallTraceRecorder, ModelCallTraceStatus, RecordModelCallTraceInput} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_MODEL_CALL_TRACE_RETENTION_DAYS = 7;

export interface ModelCallTraceListInput {
  page?: number;
  perPage?: number;
  status?: ModelCallTraceStatus;
  mode?: ModelCallTraceMode;
  runId?: string;
  sessionId?: string;
  agentKey?: string;
}

export interface ModelCallTraceListResult {
  data: readonly ModelCallTraceRecord[];
  meta: {
    current_page: number;
    last_page: number;
    per_page: number;
    total: number;
  };
}

export interface PostgresModelCallTraceStoreOptions {
  pool: PgQueryable;
  retentionDays?: number;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return parsed;
}

function requireJsonRecord(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value;
}

function optionalJsonValue(value: unknown, label: string): JsonValue | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (!isJsonValue(value)) {
    throw new Error(`${label} must be JSON-serializable.`);
  }
  return value;
}

function normalizeRequestJsonPromptCacheKey(requestJson: JsonObject): JsonObject {
  if (!Object.hasOwn(requestJson, "promptCacheKey")) {
    return requestJson;
  }
  return {
    ...requestJson,
    promptCacheKey: sanitizePromptCacheKey(requestJson.promptCacheKey),
  };
}

function parseTraceRow(row: Record<string, unknown>): ModelCallTraceRecord {
  const responseJson = optionalJsonValue(row.response_json, "Model call trace response_json");
  const errorJson = row.error_json === null || row.error_json === undefined ? undefined : requireJsonRecord(row.error_json, "Model call trace error_json");
  const usageJson = optionalJsonValue(row.usage_json, "Model call trace usage_json");
  const promptCacheKey = readOptionalString(row.prompt_cache_key);
  const requestJson = requireJsonRecord(row.request_json, "Model call trace request_json");

  return {
    id: String(row.id),
    runId: readOptionalString(row.run_id),
    threadId: readOptionalString(row.thread_id),
    sessionId: readOptionalString(row.session_id),
    agentKey: readOptionalString(row.agent_key),
    turn: readOptionalInteger(row.turn),
    callIndex: readOptionalInteger(row.call_index),
    provider: String(row.provider),
    model: String(row.model),
    mode: row.mode === "stream" ? "stream" : "complete",
    status: row.status === "failed" ? "failed" : "completed",
    startedAt: requireTimestampMillis(row.started_at, "Model call trace started_at must be a valid timestamp."),
    finishedAt: requireTimestampMillis(row.finished_at, "Model call trace finished_at must be a valid timestamp."),
    durationMs: requireNonNegativeInteger(row.duration_ms, "Model call trace duration_ms"),
    ...(promptCacheKey !== undefined ? {promptCacheKey: sanitizePromptCacheKey(promptCacheKey)} : {}),
    requestJson: normalizeRequestJsonPromptCacheKey(requestJson),
    ...(responseJson !== undefined ? {responseJson} : {}),
    ...(errorJson !== undefined ? {errorJson} : {}),
    ...(usageJson !== undefined ? {usageJson} : {}),
    expiresAt: requireTimestampMillis(row.expires_at, "Model call trace expires_at must be a valid timestamp."),
  };
}

function normalizeRetentionDays(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_MODEL_CALL_TRACE_RETENTION_DAYS;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error("Model call trace retention days must be a positive number.");
  }
  return Math.floor(value);
}

export function resolveModelCallTraceRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PANDA_MODEL_CALL_TRACE_RETENTION_DAYS?.trim();
  if (!raw) {
    return DEFAULT_MODEL_CALL_TRACE_RETENTION_DAYS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("PANDA_MODEL_CALL_TRACE_RETENTION_DAYS must be a positive integer.");
  }
  return parsed;
}

function pageInput(input: ModelCallTraceListInput): {page: number; perPage: number} {
  const page = input.page ?? 1;
  const perPage = Math.min(100, input.perPage ?? 25);
  if (!Number.isInteger(page) || page < 1) throw new Error("Control model call trace page must be a positive integer.");
  if (!Number.isInteger(perPage) || perPage < 1) throw new Error("Control model call trace per_page must be a positive integer.");
  return {page, perPage};
}

function buildListWhere(input: ModelCallTraceListInput): {sql: string; values: unknown[]} {
  const predicates: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    predicates.push(sql.replace("?", `$${values.length}`));
  };
  if (input.status) add("status = ?", input.status);
  if (input.mode) add("mode = ?", input.mode);
  if (input.runId) add("run_id = ?", input.runId);
  if (input.sessionId) add("session_id = ?", input.sessionId);
  if (input.agentKey) add("agent_key = ?", input.agentKey);
  return {
    sql: predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "",
    values,
  };
}

export class PostgresModelCallTraceStore implements ModelCallTraceRecorder {
  private readonly pool: PgQueryable;
  private readonly tables: ModelCallTraceTableNames;
  private readonly retentionDays: number;

  constructor(options: PostgresModelCallTraceStoreOptions) {
    this.pool = options.pool;
    this.tables = buildModelCallTraceTableNames();
    this.retentionDays = normalizeRetentionDays(options.retentionDays);
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresModelCallTraceSchema(this.pool);
    await this.purgeExpired();
  }

  async purgeExpired(now = Date.now()): Promise<number> {
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.traces}
      WHERE expires_at <= $1
    `, [new Date(now)]);
    return result.rowCount ?? 0;
  }

  async recordModelCallTrace(input: RecordModelCallTraceInput): Promise<void> {
    await this.purgeExpired(input.finishedAt);
    const sanitized = buildSanitizedModelCallTrace(input);
    const metadata = input.request.metadata;
    const startedAt = input.startedAt;
    const finishedAt = input.finishedAt;
    const durationMs = Math.max(0, Math.trunc(finishedAt - startedAt));
    const expiresAt = finishedAt + this.retentionDays * DAY_MS;
    const turn = metadata?.turn === undefined ? null : Math.trunc(metadata.turn);

    await this.pool.query(`
      INSERT INTO ${this.tables.traces} (
        id,
        run_id,
        thread_id,
        session_id,
        agent_key,
        turn,
        call_index,
        provider,
        model,
        mode,
        status,
        started_at,
        finished_at,
        duration_ms,
        prompt_cache_key,
        request_json,
        response_json,
        error_json,
        usage_json,
        expires_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12,
        $13,
        $14,
        $15,
        $16::jsonb,
        $17::jsonb,
        $18::jsonb,
        $19::jsonb,
        $20
      )
    `, [
      randomUUID(),
      metadata?.runId ?? null,
      metadata?.threadId ?? null,
      metadata?.sessionId ?? null,
      metadata?.agentKey ?? null,
      turn,
      turn,
      input.request.providerName,
      input.request.modelId,
      input.mode,
      input.error === undefined ? "completed" : "failed",
      new Date(startedAt),
      new Date(finishedAt),
      durationMs,
      sanitized.promptCacheKey ?? null,
      toJson(sanitized.requestJson),
      toJson(sanitized.responseJson),
      toJson(sanitized.errorJson),
      toJson(sanitized.usageJson),
      new Date(expiresAt),
    ]);
  }

  async listTraces(input: ModelCallTraceListInput = {}): Promise<ModelCallTraceListResult> {
    const {page, perPage} = pageInput(input);
    const {sql, values} = buildListWhere(input);
    const count = await this.pool.query(`
      SELECT COUNT(*)::int AS count
      FROM ${this.tables.traces}
      ${sql}
    `, values);
    const total = requireNonNegativeInteger((count.rows[0] as Record<string, unknown> | undefined)?.count ?? 0, "Model call trace count");
    const rows = await this.pool.query(`
      SELECT *
      FROM ${this.tables.traces}
      ${sql}
      ORDER BY started_at DESC, id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `, [...values, perPage, (page - 1) * perPage]);
    const data = rows.rows.map((row) => parseTraceRow(row as Record<string, unknown>));
    return {
      data,
      meta: {
        current_page: page,
        last_page: Math.max(1, Math.ceil(total / perPage)),
        per_page: perPage,
        total,
      },
    };
  }

  async getTrace(id: string): Promise<ModelCallTraceRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.traces}
      WHERE id = $1
      LIMIT 1
    `, [id]);
    const row = result.rows[0];
    return row ? parseTraceRow(row as Record<string, unknown>) : null;
  }
}
