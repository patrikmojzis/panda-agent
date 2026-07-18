import {randomUUID} from "node:crypto";

import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {isJsonObject, isJsonValue, type JsonObject, type JsonValue} from "../../lib/json.js";
import {ensurePostgresModelCallTraceSchema} from "./postgres-schema.js";
import {buildModelCallTraceTableNames, type ModelCallTraceTableNames} from "./postgres-shared.js";
import {buildSanitizedModelCallTrace, sanitizePromptCacheKey, sanitizeTraceRequestJson} from "./redaction.js";
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

export interface ModelCallTraceFailureGroupRecord {
  count: number;
  label: string;
  latestStartedAt: number;
  representative: ModelCallTraceRecord;
  summary: string;
}

export interface ModelCallUsageSample {
  startedAt: number;
  status: ModelCallTraceStatus;
  usageJson?: JsonValue;
}

export interface ModelCallUsageSampleInput {
  from: number;
  to: number;
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

function normalizeStoredRequestJson(requestJson: JsonObject): JsonObject {
  return sanitizeTraceRequestJson({
    ...requestJson,
    ...(Object.hasOwn(requestJson, "promptCacheKey")
      ? {promptCacheKey: sanitizePromptCacheKey(requestJson.promptCacheKey)}
      : {}),
  });
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
    requestJson: normalizeStoredRequestJson(requestJson),
    ...(responseJson !== undefined ? {responseJson} : {}),
    ...(errorJson !== undefined ? {errorJson} : {}),
    ...(usageJson !== undefined ? {usageJson} : {}),
    expiresAt: requireTimestampMillis(row.expires_at, "Model call trace expires_at must be a valid timestamp."),
  };
}

function parseUsageSampleRow(row: Record<string, unknown>): ModelCallUsageSample {
  const usageJson = optionalJsonValue(row.usage_json, "Model call trace usage_json");
  return {
    startedAt: requireTimestampMillis(row.started_at, "Model call trace started_at must be a valid timestamp."),
    status: row.status === "failed" ? "failed" : "completed",
    ...(usageJson !== undefined ? {usageJson} : {}),
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

function appendWherePredicate(sql: string, predicate: string): string {
  return sql ? `${sql} AND ${predicate}` : `WHERE ${predicate}`;
}

const FAILURE_LABEL_SQL = `
  CASE
    WHEN error_json->>'category' IS NOT NULL AND error_json->>'category' <> '' THEN error_json->>'category'
    WHEN error_json->>'name' IS NOT NULL AND error_json->>'name' <> '' THEN error_json->>'name'
    WHEN error_json->>'type' IS NOT NULL AND error_json->>'type' <> '' THEN error_json->>'type'
    WHEN error_json->>'code' IS NOT NULL AND error_json->>'code' <> '' THEN error_json->>'code'
    WHEN error_json->>'status' IS NOT NULL AND error_json->>'status' <> '' THEN error_json->>'status'
    ELSE 'failed'
  END
`;

const FAILURE_SUMMARY_SQL = `
  CASE
    WHEN error_json->>'message' IS NOT NULL AND error_json->>'message' <> '' THEN error_json->>'message'
    WHEN error_json->>'summary' IS NOT NULL AND error_json->>'summary' <> '' THEN error_json->>'summary'
    WHEN error_json->>'detail' IS NOT NULL AND error_json->>'detail' <> '' THEN error_json->>'detail'
    WHEN error_json->>'error' IS NOT NULL AND error_json->>'error' <> '' THEN error_json->>'error'
    WHEN error_json->>'reason' IS NOT NULL AND error_json->>'reason' <> '' THEN error_json->>'reason'
    WHEN error_json->>'category' IS NOT NULL AND error_json->>'category' <> '' THEN error_json->>'category'
    WHEN error_json->>'name' IS NOT NULL AND error_json->>'name' <> '' THEN error_json->>'name'
    WHEN error_json->>'type' IS NOT NULL AND error_json->>'type' <> '' THEN error_json->>'type'
    WHEN error_json->>'code' IS NOT NULL AND error_json->>'code' <> '' THEN error_json->>'code'
    WHEN error_json->>'status' IS NOT NULL AND error_json->>'status' <> '' THEN error_json->>'status'
    ELSE 'Failed without captured error summary'
  END
`;

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

  async listFailureGroups(input: ModelCallTraceListInput = {}, limit = 5): Promise<ModelCallTraceFailureGroupRecord[]> {
    if (input.status === "completed") return [];
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Control model call trace failure group limit must be a positive integer.");

    const {sql, values} = buildListWhere({...input, status: "failed"});
    const grouped = await this.pool.query(`
      WITH filtered AS (
        SELECT
          provider,
          model,
          mode,
          started_at,
          ${FAILURE_LABEL_SQL} AS failure_label
        FROM ${this.tables.traces}
        ${sql}
      )
      SELECT
        provider,
        model,
        mode,
        failure_label,
        COUNT(*)::int AS failure_count,
        MAX(started_at) AS latest_started_at
      FROM filtered
      GROUP BY provider, model, mode, failure_label
      ORDER BY failure_count DESC, latest_started_at DESC, provider ASC, model ASC, mode ASC, failure_label ASC
      LIMIT $${values.length + 1}
    `, [...values, limit]);

    const groups: ModelCallTraceFailureGroupRecord[] = [];
    for (const groupRow of grouped.rows) {
      const group = groupRow as Record<string, unknown>;
      const label = readOptionalString(group.failure_label) ?? "failed";
      const count = requireNonNegativeInteger(group.failure_count, "Model call trace failure group count");
      const providerIndex = values.length + 1;
      const modelIndex = values.length + 2;
      const modeIndex = values.length + 3;
      const labelIndex = values.length + 4;
      const representativeWhere = appendWherePredicate(sql, `
        provider = $${providerIndex}
        AND model = $${modelIndex}
        AND mode = $${modeIndex}
        AND (${FAILURE_LABEL_SQL}) = $${labelIndex}
      `);
      const representativeResult = await this.pool.query(`
        SELECT
          *,
          ${FAILURE_SUMMARY_SQL} AS failure_summary
        FROM ${this.tables.traces}
        ${representativeWhere}
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `, [
        ...values,
        String(group.provider),
        String(group.model),
        group.mode === "stream" ? "stream" : "complete",
        label,
      ]);
      const representativeRow = representativeResult.rows[0] as Record<string, unknown> | undefined;
      if (!representativeRow) continue;
      const representative = parseTraceRow(representativeRow);
      groups.push({
        count,
        label,
        latestStartedAt: representative.startedAt,
        representative,
        summary: readOptionalString(representativeRow.failure_summary) ?? "Failed without captured error summary",
      });
    }

    return groups;
  }

  async listUsageSamples(input: ModelCallUsageSampleInput): Promise<ModelCallUsageSample[]> {
    if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.from >= input.to) {
      throw new Error("Model call usage range must have valid ascending timestamps.");
    }
    const result = await this.pool.query(`
      SELECT started_at, status, usage_json
      FROM ${this.tables.traces}
      WHERE started_at >= $1
        AND started_at < $2
      ORDER BY started_at ASC, id ASC
    `, [new Date(input.from), new Date(input.to)]);
    return result.rows.map((row) => parseUsageSampleRow(row as Record<string, unknown>));
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
