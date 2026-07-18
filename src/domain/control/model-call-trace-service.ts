import {isJsonObject, type JsonObject, type JsonValue} from "../../lib/json.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {
  PostgresModelCallTraceStore,
  type ModelCallTraceFailureGroupRecord,
  type ModelCallTraceListInput,
  type ModelCallUsageSample,
} from "../model-call-traces/postgres.js";
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

type SessionMetadataKey = string;

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
  failureGroups: readonly ControlModelCallTraceFailureGroup[];
  meta: {
    current_page: number;
    last_page: number;
    per_page: number;
    total: number;
  };
}

export interface ControlModelCallTraceFailureGroup {
  count: number;
  label: string;
  latestStartedAt: string;
  representative: ControlModelCallTraceSummary;
  summary: string;
}

export interface ControlModelCallUsageInput {
  bucketMinutes?: number;
  rangeHours?: number;
}

export interface ControlModelCallUsageTotals {
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
  cacheHitRate: number;
  cacheReadRate: number;
}

export interface ControlModelCallUsageBucket extends ControlModelCallUsageTotals {
  startedAt: string;
}

export interface ControlModelCallUsageResult {
  buckets: readonly ControlModelCallUsageBucket[];
  range: {
    bucketMinutes: number;
    from: string;
    to: string;
  };
  summary: ControlModelCallUsageTotals;
}

const DEFAULT_USAGE_RANGE_HOURS = 7 * 24;
const DEFAULT_USAGE_BUCKET_MINUTES = 6 * 60;
const MAX_USAGE_RANGE_HOURS = 90 * 24;
const MAX_USAGE_BUCKETS = 1_000;

type MutableUsageTotals = Omit<ControlModelCallUsageTotals, "cacheHitRate" | "cacheReadRate">;

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

function publicTraceText(value: string): string {
  const sanitized = sanitizeTraceJson(value);
  return typeof sanitized === "string" ? sanitized : String(sanitized);
}

function sessionLabel(metadata: Pick<ControlModelCallSessionMetadata, "sessionAlias" | "sessionDisplayName"> & {id: string}): string {
  return metadata.sessionDisplayName?.trim() || metadata.sessionAlias?.trim() || metadata.id;
}

function sessionMetadataKey(agentKey: string, sessionId: string): SessionMetadataKey {
  return JSON.stringify([agentKey, sessionId]);
}

function publicSessionMetadata(row: Record<string, unknown>): {key: SessionMetadataKey; metadata: ControlModelCallSessionMetadata} {
  const id = String(row.id);
  const agentKey = String(row.agent_key);
  const sessionDisplayName = readOptionalString(row.display_name);
  const sessionAlias = readOptionalString(row.alias);
  const sessionKind = readOptionalString(row.kind) ?? "session";
  return {
    key: sessionMetadataKey(agentKey, id),
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

function publicFailureGroup(
  group: ModelCallTraceFailureGroupRecord,
  metadata?: ControlModelCallSessionMetadata,
): ControlModelCallTraceFailureGroup {
  return {
    count: group.count,
    label: publicTraceText(group.label),
    latestStartedAt: iso(group.latestStartedAt),
    representative: publicSummary(group.representative, metadata),
    summary: publicTraceText(group.summary),
  };
}

function emptyUsageTotals(): MutableUsageTotals {
  return {
    calls: 0,
    cacheHits: 0,
    usageCalls: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    cacheReadCost: 0,
  };
}

function usageNumber(value: JsonObject, key: string): number {
  const entry = value[key];
  return typeof entry === "number" && Number.isFinite(entry) && entry >= 0 ? entry : 0;
}

function addUsageSample(total: MutableUsageTotals, sample: ModelCallUsageSample): void {
  total.calls += 1;
  if (sample.status === "failed") total.failures += 1;
  if (!isJsonObject(sample.usageJson)) return;

  const usage = sample.usageJson;
  const inputTokens = usageNumber(usage, "input");
  const outputTokens = usageNumber(usage, "output");
  const cacheReadTokens = usageNumber(usage, "cacheRead");
  const cacheWriteTokens = usageNumber(usage, "cacheWrite");
  const summedTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const totalTokens = usageNumber(usage, "totalTokens") || summedTokens;
  const cost = isJsonObject(usage.cost) ? usage.cost : {};
  const componentCost = usageNumber(cost, "input")
    + usageNumber(cost, "output")
    + usageNumber(cost, "cacheRead")
    + usageNumber(cost, "cacheWrite");

  total.usageCalls += 1;
  if (cacheReadTokens > 0) total.cacheHits += 1;
  total.inputTokens += inputTokens;
  total.outputTokens += outputTokens;
  total.cacheReadTokens += cacheReadTokens;
  total.cacheWriteTokens += cacheWriteTokens;
  total.totalTokens += totalTokens;
  total.totalCost += usageNumber(cost, "total") || componentCost;
  total.cacheReadCost += usageNumber(cost, "cacheRead");
}

function publicUsageTotals(total: MutableUsageTotals): ControlModelCallUsageTotals {
  const promptTokens = total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens;
  return {
    ...total,
    cacheHitRate: total.usageCalls > 0 ? total.cacheHits / total.usageCalls : 0,
    cacheReadRate: promptTokens > 0 ? total.cacheReadTokens / promptTokens : 0,
  };
}

function usageWindow(input: ControlModelCallUsageInput, now: number) {
  const rangeHours = input.rangeHours ?? DEFAULT_USAGE_RANGE_HOURS;
  const bucketMinutes = input.bucketMinutes ?? DEFAULT_USAGE_BUCKET_MINUTES;
  if (!Number.isInteger(rangeHours) || rangeHours < 1 || rangeHours > MAX_USAGE_RANGE_HOURS) {
    throw new Error(`Control model call usage range_hours must be between 1 and ${MAX_USAGE_RANGE_HOURS}.`);
  }
  if (!Number.isInteger(bucketMinutes) || bucketMinutes < 5 || bucketMinutes > 24 * 60) {
    throw new Error("Control model call usage bucket_minutes must be between 5 and 1440.");
  }
  const bucketCount = Math.ceil((rangeHours * 60) / bucketMinutes);
  if (bucketCount > MAX_USAGE_BUCKETS) {
    throw new Error(`Control model call usage range may contain at most ${MAX_USAGE_BUCKETS} buckets.`);
  }
  const bucketMs = bucketMinutes * 60_000;
  return {
    bucketMinutes,
    bucketMs,
    from: now - rangeHours * 60 * 60_000,
    to: now,
  };
}

/** Builds gap-free usage buckets for the Control analytics charts. */
export function buildModelCallUsageAnalytics(
  samples: readonly ModelCallUsageSample[],
  input: ControlModelCallUsageInput = {},
  now = Date.now(),
): ControlModelCallUsageResult {
  if (!Number.isFinite(now)) throw new Error("Control model call usage current time must be finite.");
  const window = usageWindow(input, now);
  const firstBucket = Math.floor(window.from / window.bucketMs) * window.bucketMs;
  const lastBucket = Math.floor((window.to - 1) / window.bucketMs) * window.bucketMs;
  const totals = emptyUsageTotals();
  const bucketTotals = new Map<number, MutableUsageTotals>();

  for (let startedAt = firstBucket; startedAt <= lastBucket; startedAt += window.bucketMs) {
    bucketTotals.set(startedAt, emptyUsageTotals());
  }
  for (const sample of samples) {
    if (sample.startedAt < window.from || sample.startedAt >= window.to) continue;
    const bucketStartedAt = Math.floor(sample.startedAt / window.bucketMs) * window.bucketMs;
    const bucket = bucketTotals.get(bucketStartedAt);
    if (!bucket) continue;
    addUsageSample(bucket, sample);
    addUsageSample(totals, sample);
  }

  return {
    buckets: [...bucketTotals.entries()].map(([startedAt, total]) => ({
      startedAt: iso(startedAt),
      ...publicUsageTotals(total),
    })),
    range: {
      bucketMinutes: window.bucketMinutes,
      from: iso(window.from),
      to: iso(window.to),
    },
    summary: publicUsageTotals(totals),
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

  private async readSessionMetadata(traces: readonly ModelCallTraceRecord[]): Promise<Map<SessionMetadataKey, ControlModelCallSessionMetadata>> {
    const pairs = Array.from(new Map(
      traces
        .filter((trace) => trace.sessionId && trace.agentKey)
        .map((trace) => [
          sessionMetadataKey(trace.agentKey!, trace.sessionId!),
          {agentKey: trace.agentKey!, sessionId: trace.sessionId!},
        ] as const),
    ).values());
    if (pairs.length === 0) return new Map();

    const predicates = pairs.map((_, index) => `(id = $${index * 2 + 1} AND agent_key = $${index * 2 + 2})`).join(" OR ");
    const values = pairs.flatMap((pair) => [pair.sessionId, pair.agentKey]);
    const result = await this.pool.query(`
      SELECT id, agent_key, kind, alias, display_name
      FROM ${this.sessionTables.sessions}
      WHERE ${predicates}
    `, values);

    return new Map(
      result.rows.map((row) => {
        const entry = publicSessionMetadata(row as Record<string, unknown>);
        return [entry.key, entry.metadata] as const;
      }),
    );
  }

  async listModelCallTraces(
    session: ControlSessionRecord,
    input: ControlModelCallTraceListInput = {},
  ): Promise<ControlModelCallTraceListResult> {
    this.assertAdmin(session);
    const result = await this.store.listTraces(input);
    const failureGroups = await this.store.listFailureGroups(input, 3);
    const sessionMetadata = await this.readSessionMetadata([
      ...result.data,
      ...failureGroups.map((group) => group.representative),
    ]);
    return {
      data: result.data.map((trace) => publicSummary(trace, trace.sessionId && trace.agentKey ? sessionMetadata.get(sessionMetadataKey(trace.agentKey, trace.sessionId)) : undefined)),
      failureGroups: failureGroups.map((group) => publicFailureGroup(
        group,
        group.representative.sessionId && group.representative.agentKey
          ? sessionMetadata.get(sessionMetadataKey(group.representative.agentKey, group.representative.sessionId))
          : undefined,
      )),
      meta: result.meta,
    };
  }

  async getModelCallTrace(session: ControlSessionRecord, id: string): Promise<ControlModelCallTraceDetail | null> {
    this.assertAdmin(session);
    const trace = await this.store.getTrace(id);
    if (!trace) return null;
    const sessionMetadata = await this.readSessionMetadata([trace]);
    return publicDetail(trace, trace.sessionId && trace.agentKey ? sessionMetadata.get(sessionMetadataKey(trace.agentKey, trace.sessionId)) : undefined);
  }

  async getModelCallUsage(
    session: ControlSessionRecord,
    input: ControlModelCallUsageInput = {},
    now = Date.now(),
  ): Promise<ControlModelCallUsageResult> {
    this.assertAdmin(session);
    const window = usageWindow(input, now);
    const samples = await this.store.listUsageSamples({from: window.from, to: window.to});
    return buildModelCallUsageAnalytics(samples, input, now);
  }
}
