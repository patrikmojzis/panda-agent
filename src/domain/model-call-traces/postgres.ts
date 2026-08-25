import type {PgPoolLike} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {isJsonObject, isJsonValue, type JsonObject, type JsonValue} from "../../lib/json.js";
import {buildModelCallTraceTableNames, type ModelCallTraceTableNames} from "./postgres-shared.js";
import {MODEL_CALL_SNAPSHOT_REDACTION_VERSION} from "./redaction.js";
import type {
  ModelCallAttemptRecord,
  ModelCallAttemptWrite,
  ModelCallFailure,
  ModelCallSnapshotStatus,
  ModelCallTraceMode,
  ModelCallTraceStatus,
  ModelCallUsage,
} from "./types.js";

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
  data: readonly ModelCallAttemptRecord[];
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
  representative: ModelCallAttemptRecord;
  summary: string;
}

export interface ModelCallUsageBucketRecord {
  startedAt: number;
  calls: number;
  cacheHits: number;
  usageCalls: number;
  failures: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  totalCost: number;
  cacheReadCost: number;
}

export interface ModelCallUsageBucketInput {
  from: number;
  to: number;
  bucketMs: number;
}

export interface PostgresModelCallTraceStoreOptions {
  pool: PgPoolLike;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readOptionalInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  const parsed = readOptionalInteger(value);
  if (parsed === undefined || parsed < 0) throw new Error(`${label} must be a non-negative safe integer.`);
  return parsed;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = requireNonNegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} must be a positive safe integer.`);
  return parsed;
}

function requireJsonRecord(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) throw new Error(`${label} must be a JSON object.`);
  return value;
}

function optionalJsonValue(value: unknown, label: string): JsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isJsonValue(value)) throw new Error(`${label} must be JSON-serializable.`);
  return value;
}

function readSnapshotStatus(value: unknown): ModelCallSnapshotStatus {
  if (value === "captured" || value === "truncated" || value === "dropped") return value;
  return "not_captured";
}

function parseUsage(row: Record<string, unknown>): ModelCallUsage | undefined {
  if (row.usage_captured !== true) return undefined;
  return {
    inputTokens: requireNonNegativeInteger(row.input_tokens, "Model call input_tokens"),
    outputTokens: requireNonNegativeInteger(row.output_tokens, "Model call output_tokens"),
    cacheReadTokens: requireNonNegativeInteger(row.cache_read_tokens, "Model call cache_read_tokens"),
    cacheWriteTokens: requireNonNegativeInteger(row.cache_write_tokens, "Model call cache_write_tokens"),
    totalTokens: requireNonNegativeInteger(row.total_tokens, "Model call total_tokens"),
    inputCost: readOptionalNumber(row.input_cost) ?? 0,
    outputCost: readOptionalNumber(row.output_cost) ?? 0,
    cacheReadCost: readOptionalNumber(row.cache_read_cost) ?? 0,
    cacheWriteCost: readOptionalNumber(row.cache_write_cost) ?? 0,
    totalCost: readOptionalNumber(row.total_cost) ?? 0,
  };
}

function usageAsJson(usage: ModelCallUsage | undefined): JsonObject | undefined {
  if (!usage) return undefined;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead: usage.cacheReadTokens,
    cacheWrite: usage.cacheWriteTokens,
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.inputCost,
      output: usage.outputCost,
      cacheRead: usage.cacheReadCost,
      cacheWrite: usage.cacheWriteCost,
      total: usage.totalCost,
    },
  };
}

function failureAsJson(failure: ModelCallFailure | undefined): JsonObject | undefined {
  if (!failure) return undefined;
  return {
    category: failure.category,
    message: failure.message,
    ...(failure.provider ? {provider: failure.provider} : {}),
    ...(failure.model ? {model: failure.model} : {}),
    ...(failure.status === undefined ? {} : {status: failure.status}),
    ...(failure.retryable === undefined ? {} : {retryable: failure.retryable}),
    ...(failure.timedOut === undefined ? {} : {timedOut: failure.timedOut}),
    ...(failure.stopReason ? {stopReason: failure.stopReason} : {}),
  };
}

function parseFailure(row: Record<string, unknown>): ModelCallFailure | undefined {
  const category = readOptionalString(row.error_category);
  const message = readOptionalString(row.error_message);
  if (!category || !message) return undefined;
  const provider = readOptionalString(row.error_provider);
  const model = readOptionalString(row.error_model);
  const status = readOptionalInteger(row.error_status);
  const stopReason = readOptionalString(row.error_stop_reason);
  return {
    category,
    message,
    ...(provider ? {provider} : {}),
    ...(model ? {model} : {}),
    ...(status === undefined ? {} : {status}),
    ...(typeof row.error_retryable === "boolean" ? {retryable: row.error_retryable} : {}),
    ...(typeof row.error_timed_out === "boolean" ? {timedOut: row.error_timed_out} : {}),
    ...(stopReason ? {stopReason} : {}),
  };
}

function parseAttemptRow(row: Record<string, unknown>): ModelCallAttemptRecord {
  const usage = parseUsage(row);
  const failure = parseFailure(row);
  const requestJson = row.request_json === null || row.request_json === undefined
    ? undefined
    : requireJsonRecord(row.request_json, "Model call snapshot request_json");
  const responseJson = optionalJsonValue(row.response_json, "Model call snapshot response_json");
  const snapshotExpiresAt = row.snapshot_expires_at === null || row.snapshot_expires_at === undefined
    ? undefined
    : requireTimestampMillis(row.snapshot_expires_at, "Model call snapshot expires_at must be a valid timestamp.");
  const snapshot = requestJson && snapshotExpiresAt !== undefined
    ? {
        requestJson,
        ...(responseJson === undefined ? {} : {responseJson}),
        bytes: requireNonNegativeInteger(row.snapshot_bytes, "Model call snapshot_bytes"),
        truncated: row.snapshot_truncated === true,
        expiresAt: snapshotExpiresAt,
      }
    : undefined;

  return {
    id: String(row.id),
    runId: readOptionalString(row.run_id),
    threadId: readOptionalString(row.thread_id),
    sessionId: readOptionalString(row.session_id),
    agentKey: readOptionalString(row.agent_key),
    turn: readOptionalInteger(row.turn),
    attempt: requirePositiveInteger(row.attempt_ordinal, "Model call attempt_ordinal"),
    provider: String(row.provider),
    model: String(row.model),
    mode: row.mode === "stream" ? "stream" : "complete",
    status: row.status === "failed" ? "failed" : "completed",
    startedAt: requireTimestampMillis(row.started_at, "Model call started_at must be a valid timestamp."),
    finishedAt: requireTimestampMillis(row.finished_at, "Model call finished_at must be a valid timestamp."),
    durationMs: requireNonNegativeInteger(row.duration_ms, "Model call duration_ms"),
    ...(readOptionalString(row.prompt_cache_key) ? {promptCacheKey: readOptionalString(row.prompt_cache_key)} : {}),
    ...(usage ? {usage} : {}),
    ...(failure ? {failure} : {}),
    requestShape: {
      systemPromptChars: requireNonNegativeInteger(row.system_prompt_chars, "Model call system_prompt_chars"),
      messageCount: requireNonNegativeInteger(row.message_count, "Model call message_count"),
      toolCount: requireNonNegativeInteger(row.tool_count, "Model call tool_count"),
      contextSectionCount: requireNonNegativeInteger(row.context_section_count, "Model call context_section_count"),
      contextChars: requireNonNegativeInteger(row.context_chars, "Model call context_chars"),
    },
    snapshotStatus: readSnapshotStatus(row.snapshot_status),
    ...(snapshot ? {snapshot} : {}),
    expiresAt: requireTimestampMillis(row.expires_at, "Model call expires_at must be a valid timestamp."),
  };
}

function pageInput(input: ModelCallTraceListInput): {page: number; perPage: number} {
  const page = input.page ?? 1;
  const perPage = Math.min(100, input.perPage ?? 25);
  if (!Number.isInteger(page) || page < 1) throw new Error("Control model call page must be a positive integer.");
  if (!Number.isInteger(perPage) || perPage < 1) throw new Error("Control model call per_page must be a positive integer.");
  return {page, perPage};
}

function buildListWhere(input: ModelCallTraceListInput): {sql: string; values: unknown[]} {
  const predicates: string[] = [];
  const values: unknown[] = [];
  const add = (sql: string, value: unknown) => {
    values.push(value);
    predicates.push(sql.replace("?", `$${values.length}`));
  };
  if (input.status) add("a.status = ?", input.status);
  if (input.mode) add("a.mode = ?", input.mode);
  if (input.runId) add("a.run_id = ?", input.runId);
  if (input.sessionId) add("a.session_id = ?", input.sessionId);
  if (input.agentKey) add("a.agent_key = ?", input.agentKey);
  return {
    sql: predicates.length > 0 ? `WHERE ${predicates.join(" AND ")}` : "",
    values,
  };
}

const ATTEMPT_COLUMNS = `
  a.id,
  a.run_id,
  a.thread_id,
  a.session_id,
  a.agent_key,
  a.turn,
  a.attempt_ordinal,
  a.provider,
  a.model,
  a.mode,
  a.status,
  a.started_at,
  a.finished_at,
  a.duration_ms,
  a.prompt_cache_key,
  a.usage_captured,
  a.input_tokens,
  a.output_tokens,
  a.cache_read_tokens,
  a.cache_write_tokens,
  a.total_tokens,
  a.input_cost,
  a.output_cost,
  a.cache_read_cost,
  a.cache_write_cost,
  a.total_cost,
  a.error_category,
  a.error_message,
  a.error_provider,
  a.error_model,
  a.error_status,
  a.error_retryable,
  a.error_timed_out,
  a.error_stop_reason,
  a.system_prompt_chars,
  a.message_count,
  a.tool_count,
  a.context_section_count,
  a.context_chars,
  a.snapshot_status,
  a.expires_at
`;

function valueRows(rows: readonly (readonly unknown[])[], startIndex = 1): {sql: string; values: unknown[]} {
  const values: unknown[] = [];
  const sql = rows.map((row) => {
    const placeholders = row.map((value) => {
      values.push(value);
      return `$${startIndex + values.length - 1}`;
    });
    return `(${placeholders.join(", ")})`;
  }).join(",\n");
  return {sql, values};
}

function attemptValues(write: ModelCallAttemptWrite): readonly unknown[] {
  const usage = write.usage;
  const failure = write.failure;
  return [
    write.id,
    write.runId ?? null,
    write.threadId ?? null,
    write.sessionId ?? null,
    write.agentKey ?? null,
    write.turn ?? null,
    write.attempt,
    write.provider,
    write.model,
    write.mode,
    write.status,
    new Date(write.startedAt),
    new Date(write.finishedAt),
    write.durationMs,
    write.promptCacheKey ?? null,
    Boolean(usage),
    usage?.inputTokens ?? null,
    usage?.outputTokens ?? null,
    usage?.cacheReadTokens ?? null,
    usage?.cacheWriteTokens ?? null,
    usage?.totalTokens ?? null,
    usage?.inputCost ?? null,
    usage?.outputCost ?? null,
    usage?.cacheReadCost ?? null,
    usage?.cacheWriteCost ?? null,
    usage?.totalCost ?? null,
    failure?.category ?? null,
    failure?.message ?? null,
    failure?.provider ?? null,
    failure?.model ?? null,
    failure?.status ?? null,
    failure?.retryable ?? null,
    failure?.timedOut ?? null,
    failure?.stopReason ?? null,
    write.requestShape.systemPromptChars,
    write.requestShape.messageCount,
    write.requestShape.toolCount,
    write.requestShape.contextSectionCount,
    write.requestShape.contextChars,
    write.snapshotStatus,
    new Date(write.expiresAt),
  ];
}

export class PostgresModelCallTraceStore {
  private readonly pool: PgPoolLike;
  private readonly tables: ModelCallTraceTableNames;

  constructor(options: PostgresModelCallTraceStoreOptions) {
    this.pool = options.pool;
    this.tables = buildModelCallTraceTableNames();
  }

  async insertAttempts(attempts: readonly ModelCallAttemptWrite[]): Promise<void> {
    if (attempts.length === 0) return;
    const attemptRows = valueRows(attempts.map(attemptValues));
    const snapshots = attempts.filter((attempt) => attempt.snapshot);

    await withTransaction(this.pool, async (client) => {
      await client.query(`
        INSERT INTO ${this.tables.attempts} (
          id, run_id, thread_id, session_id, agent_key, turn, attempt_ordinal,
          provider, model, mode, status, started_at, finished_at, duration_ms,
          prompt_cache_key, usage_captured, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, total_tokens, input_cost,
          output_cost, cache_read_cost, cache_write_cost, total_cost,
          error_category, error_message, error_provider, error_model,
          error_status, error_retryable, error_timed_out, error_stop_reason,
          system_prompt_chars, message_count, tool_count, context_section_count,
          context_chars, snapshot_status, expires_at
        ) VALUES ${attemptRows.sql}
        ON CONFLICT (id) DO NOTHING
      `, attemptRows.values);

      if (snapshots.length === 0) return;
      const snapshotRows = valueRows(snapshots.map((attempt) => [
        attempt.id,
        toJson(attempt.snapshot!.requestJson),
        toJson(attempt.snapshot!.responseJson),
        attempt.snapshot!.bytes,
        attempt.snapshot!.truncated,
        MODEL_CALL_SNAPSHOT_REDACTION_VERSION,
        new Date(attempt.snapshot!.expiresAt),
      ]));
      await client.query(`
        INSERT INTO ${this.tables.snapshots} (
          attempt_id, request_json, response_json, snapshot_bytes,
          truncated, redaction_version, expires_at
        ) VALUES ${snapshotRows.sql}
        ON CONFLICT (attempt_id) DO NOTHING
      `, snapshotRows.values);
    });
  }

  async purgeExpiredBatch(now: number, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Model call purge limit must be positive.");
    const snapshots = await this.pool.query(`
      DELETE FROM ${this.tables.snapshots}
      WHERE attempt_id IN (
        SELECT attempt_id
        FROM ${this.tables.snapshots}
        WHERE expires_at <= $1
        ORDER BY expires_at ASC
        LIMIT $2
      )
    `, [new Date(now), limit]);
    const attempts = await this.pool.query(`
      DELETE FROM ${this.tables.attempts}
      WHERE id IN (
        SELECT id
        FROM ${this.tables.attempts}
        WHERE expires_at <= $1
        ORDER BY expires_at ASC
        LIMIT $2
      )
    `, [new Date(now), limit]);
    // The recorder uses a full batch as its catch-up signal. Either relation
    // hitting the limit means another bounded maintenance pass is warranted.
    return Math.max(snapshots.rowCount ?? 0, attempts.rowCount ?? 0);
  }

  async listTraces(input: ModelCallTraceListInput = {}): Promise<ModelCallTraceListResult> {
    const {page, perPage} = pageInput(input);
    const {sql, values} = buildListWhere(input);
    const count = await this.pool.query(`
      SELECT COUNT(*)::int AS count
      FROM ${this.tables.attempts} a
      ${sql}
    `, values);
    const total = requireNonNegativeInteger(
      (count.rows[0] as Record<string, unknown> | undefined)?.count ?? 0,
      "Model call count",
    );
    const rows = await this.pool.query(`
      SELECT ${ATTEMPT_COLUMNS}
      FROM ${this.tables.attempts} a
      ${sql}
      ORDER BY a.started_at DESC, a.id DESC
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
    `, [...values, perPage, (page - 1) * perPage]);
    return {
      data: rows.rows.map((row) => parseAttemptRow(row as Record<string, unknown>)),
      meta: {
        current_page: page,
        last_page: Math.max(1, Math.ceil(total / perPage)),
        per_page: perPage,
        total,
      },
    };
  }

  async listFailureGroups(
    input: ModelCallTraceListInput = {},
    limit = 5,
  ): Promise<ModelCallTraceFailureGroupRecord[]> {
    if (input.status === "completed") return [];
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Model call failure group limit must be positive.");
    const {sql, values} = buildListWhere({...input, status: "failed"});
    const grouped = await this.pool.query(`
      SELECT
        a.provider,
        a.model,
        a.mode,
        COALESCE(a.error_category, 'failed') AS failure_label,
        COUNT(*)::int AS failure_count,
        MAX(a.started_at) AS latest_started_at
      FROM ${this.tables.attempts} a
      ${sql}
      GROUP BY a.provider, a.model, a.mode, COALESCE(a.error_category, 'failed')
      ORDER BY failure_count DESC, latest_started_at DESC, a.provider ASC, a.model ASC, a.mode ASC, failure_label ASC
      LIMIT $${values.length + 1}
    `, [...values, limit]);

    if (grouped.rows.length === 0) return [];
    const representativeValues = [...values];
    const representativePredicates = grouped.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      const indexes = [row.provider, row.model, row.mode, row.failure_label, row.latest_started_at].map((value) => {
        representativeValues.push(value);
        return representativeValues.length;
      });
      return `(
        a.provider = $${indexes[0]}
        AND a.model = $${indexes[1]}
        AND a.mode = $${indexes[2]}
        AND COALESCE(a.error_category, 'failed') = $${indexes[3]}
        AND a.started_at = $${indexes[4]}
      )`;
    });
    const representativeWhere = sql
      ? `${sql} AND (${representativePredicates.join(" OR ")})`
      : `WHERE ${representativePredicates.join(" OR ")}`;
    const representatives = await this.pool.query(`
      SELECT ${ATTEMPT_COLUMNS}, COALESCE(a.error_category, 'failed') AS failure_label
      FROM ${this.tables.attempts} a
      ${representativeWhere}
      ORDER BY a.started_at DESC, a.id DESC
    `, representativeValues);
    const representativeByGroup = new Map<string, ModelCallAttemptRecord>();
    for (const raw of representatives.rows) {
      const row = raw as Record<string, unknown>;
      const key = JSON.stringify([row.provider, row.model, row.mode, row.failure_label]);
      if (!representativeByGroup.has(key)) representativeByGroup.set(key, parseAttemptRow(row));
    }

    return grouped.rows.flatMap((raw) => {
      const row = raw as Record<string, unknown>;
      const label = readOptionalString(row.failure_label) ?? "failed";
      const key = JSON.stringify([row.provider, row.model, row.mode, label]);
      const representative = representativeByGroup.get(key);
      if (!representative) return [];
      return {
        count: requireNonNegativeInteger(row.failure_count, "Model call failure count"),
        label,
        latestStartedAt: requireTimestampMillis(row.latest_started_at, "Model call failure latest_started_at must be valid."),
        representative,
        summary: representative.failure?.message ?? "Failed without captured error summary",
      };
    });
  }

  async listUsageBuckets(input: ModelCallUsageBucketInput): Promise<ModelCallUsageBucketRecord[]> {
    if (!Number.isFinite(input.from) || !Number.isFinite(input.to) || input.from >= input.to) {
      throw new Error("Model call usage range must have valid ascending timestamps.");
    }
    if (!Number.isSafeInteger(input.bucketMs) || input.bucketMs < 1) {
      throw new Error("Model call usage bucket must be a positive integer number of milliseconds.");
    }
    const firstBucket = Math.floor(input.from / input.bucketMs) * input.bucketMs;
    const result = await this.pool.query(`
      SELECT
        FLOOR((EXTRACT(EPOCH FROM started_at) * 1000 - $3) / $4)::int AS bucket_index,
        COUNT(*)::int AS calls,
        SUM(CASE WHEN usage_captured AND cache_read_tokens > 0 THEN 1 ELSE 0 END)::int AS cache_hits,
        SUM(CASE WHEN usage_captured THEN 1 ELSE 0 END)::int AS usage_calls,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END)::int AS failures,
        COALESCE(SUM(CASE WHEN usage_captured THEN input_tokens ELSE 0 END), 0)::bigint AS input_tokens,
        COALESCE(SUM(CASE WHEN usage_captured THEN output_tokens ELSE 0 END), 0)::bigint AS output_tokens,
        COALESCE(SUM(CASE WHEN usage_captured THEN cache_read_tokens ELSE 0 END), 0)::bigint AS cache_read_tokens,
        COALESCE(SUM(CASE WHEN usage_captured THEN cache_write_tokens ELSE 0 END), 0)::bigint AS cache_write_tokens,
        COALESCE(SUM(CASE WHEN usage_captured THEN total_tokens ELSE 0 END), 0)::bigint AS total_tokens,
        COALESCE(SUM(CASE WHEN usage_captured THEN total_cost ELSE 0 END), 0)::double precision AS total_cost,
        COALESCE(SUM(CASE WHEN usage_captured THEN cache_read_cost ELSE 0 END), 0)::double precision AS cache_read_cost
      FROM ${this.tables.attempts}
      WHERE started_at >= $1
        AND started_at < $2
      GROUP BY bucket_index
      ORDER BY bucket_index ASC
    `, [new Date(input.from), new Date(input.to), firstBucket, input.bucketMs]);
    return result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      const bucketIndex = requireNonNegativeInteger(row.bucket_index, "Model call usage bucket_index");
      return {
        startedAt: firstBucket + bucketIndex * input.bucketMs,
        calls: requireNonNegativeInteger(row.calls, "Model call usage calls"),
        cacheHits: requireNonNegativeInteger(row.cache_hits, "Model call usage cache_hits"),
        usageCalls: requireNonNegativeInteger(row.usage_calls, "Model call usage usage_calls"),
        failures: requireNonNegativeInteger(row.failures, "Model call usage failures"),
        inputTokens: requireNonNegativeInteger(row.input_tokens, "Model call usage input_tokens"),
        outputTokens: requireNonNegativeInteger(row.output_tokens, "Model call usage output_tokens"),
        cacheReadTokens: requireNonNegativeInteger(row.cache_read_tokens, "Model call usage cache_read_tokens"),
        cacheWriteTokens: requireNonNegativeInteger(row.cache_write_tokens, "Model call usage cache_write_tokens"),
        totalTokens: requireNonNegativeInteger(row.total_tokens, "Model call usage total_tokens"),
        totalCost: readOptionalNumber(row.total_cost) ?? 0,
        cacheReadCost: readOptionalNumber(row.cache_read_cost) ?? 0,
      };
    });
  }

  async getTrace(id: string): Promise<ModelCallAttemptRecord | null> {
    const result = await this.pool.query(`
      SELECT
        ${ATTEMPT_COLUMNS},
        s.request_json,
        s.response_json,
        s.snapshot_bytes,
        s.truncated AS snapshot_truncated,
        s.expires_at AS snapshot_expires_at
      FROM ${this.tables.attempts} a
      LEFT JOIN ${this.tables.snapshots} s ON s.attempt_id = a.id
      WHERE a.id = $1
      LIMIT 1
    `, [id]);
    const row = result.rows[0];
    return row ? parseAttemptRow(row as Record<string, unknown>) : null;
  }
}

export function modelCallUsageJson(record: ModelCallAttemptRecord): JsonObject | undefined {
  return usageAsJson(record.usage);
}

export function modelCallFailureJson(record: ModelCallAttemptRecord): JsonObject | undefined {
  return failureAsJson(record.failure);
}
