import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildWatchTableNames} from "../watches/postgres-shared.js";
import type {WatchStore} from "../watches/store.js";
import type {WatchObservationKind, WatchRecord, WatchRunStatus, WatchSourceKind} from "../watches/types.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

const DEFAULT_WATCH_LIMIT = 50;
const MAX_WATCH_LIMIT = 100;

export type ControlWatchDetectorKind = "new_items" | "snapshot_changed" | "percent_change";
export type ControlWatchLifecycleStatus = "enabled" | "disabled" | "cooldown" | "running";
export type ControlWatchSortDirection = "asc" | "desc";
export type ControlWatchSourceKind = WatchSourceKind;

export interface ControlWatchLatestRun {
  id: string;
  status: WatchRunStatus;
  scheduledFor: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

export interface ControlWatch {
  id: string;
  title: string;
  sourceKind: WatchSourceKind | null;
  detectorKind: ControlWatchDetectorKind | null;
  observationKind: WatchObservationKind | null;
  intervalMinutes: number;
  enabled: boolean;
  lifecycleStatus: ControlWatchLifecycleStatus;
  nextPollAt: string | null;
  disabledAt: string | null;
  cooldownUntil: string | null;
  createdAt: string;
  updatedAt: string;
  recentRunCount: number;
  eventCount: number;
  latestRun: ControlWatchLatestRun | null;
}

export interface ControlWatchesRecord {
  agentKey: string;
  sessionId: string;
  data: readonly ControlWatch[];
  meta: ControlWatchesTableMeta;
  watches: readonly ControlWatch[];
}

export interface GetWatchesInput {
  page?: number;
  perPage?: number;
  sortBy?: string;
  sortDirection?: ControlWatchSortDirection;
  search?: string;
  lifecycleStatus?: ControlWatchLifecycleStatus;
  sourceKind?: ControlWatchSourceKind;
  limit?: number;
}

export interface ControlWatchesTableMeta {
  current_page: number;
  last_page: number;
  total: number;
  per_page: number;
}

export interface UpdateControlWatchInput {
  title?: unknown;
  intervalMinutes?: unknown;
  enabled?: unknown;
}

export interface DisableControlWatchInput {
  reason?: unknown;
}

export interface ControlWatchWriteResult {
  watch: ControlWatch;
  audit: Record<string, unknown>;
}

type WatchRow = Record<string, unknown>;
type ControlWatchStore = Pick<WatchStore, "updateWatch" | "disableWatch">;

function toIso(value: unknown, label: string): string {
  const millis = value instanceof Date ? value.getTime() : typeof value === "number" ? value : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(millis)) throw new Error(`${label} must be a valid timestamp.`);
  return new Date(millis).toISOString();
}

function optionalIso(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return toIso(value, label);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is missing.`);
  return value;
}

function optionalKind<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : null;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new Error(`${label} is missing.`);
}

function lifecycleStatus(row: WatchRow): ControlWatchLifecycleStatus {
  if (row.enabled === false || row.disabled_at) return "disabled";
  if (row.claimed_at) return "running";
  if (row.cooldown_until) return "cooldown";
  return "enabled";
}

function pageInput(input: GetWatchesInput): {page: number; perPage: number} {
  const page = input.page ?? 1;
  const perPage = input.perPage ?? input.limit ?? DEFAULT_WATCH_LIMIT;
  if (!Number.isInteger(page) || page < 1) throw new Error("Control watches page must be a positive integer.");
  if (!Number.isInteger(perPage) || perPage < 1) throw new Error("Control watches per_page must be a positive integer.");
  return {page, perPage: Math.min(MAX_WATCH_LIMIT, perPage)};
}

function normalizeSearch(value: string | undefined): string {
  return value?.trim() ?? "";
}

function lifecycleStatusExpression(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `
    CASE
      WHEN ${prefix}enabled = FALSE OR ${prefix}disabled_at IS NOT NULL THEN 'disabled'
      WHEN ${prefix}claimed_at IS NOT NULL THEN 'running'
      WHEN ${prefix}cooldown_until IS NOT NULL THEN 'cooldown'
      ELSE 'enabled'
    END
  `;
}

function sourceKindExpression(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}source_config->>'kind'`;
}

function detectorKindExpression(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `${prefix}detector_config->>'kind'`;
}

function activitySortExpression(tables: ReturnType<typeof buildWatchTableNames>): string {
  return `(
    (SELECT COUNT(*) FROM ${tables.watchEvents} AS activity_events WHERE activity_events.session_id = watch_row.session_id AND activity_events.watch_id = watch_row.id)
    +
    (SELECT COUNT(*) FROM ${tables.watchRuns} AS activity_runs WHERE activity_runs.session_id = watch_row.session_id AND activity_runs.watch_id = watch_row.id AND activity_runs.created_at >= NOW() - INTERVAL '30 days')
  )`;
}

function sortExpression(sortBy: string | undefined, tables: ReturnType<typeof buildWatchTableNames>): string {
  switch (sortBy) {
    case "title":
      return "watch_row.title";
    case "lifecycleStatus":
      return lifecycleStatusExpression("watch_row");
    case "source":
    case "sourceKind":
      return sourceKindExpression("watch_row");
    case "detectorKind":
      return detectorKindExpression("watch_row");
    case "intervalMinutes":
      return "watch_row.interval_minutes";
    case "nextPollAt":
      return "watch_row.next_poll_at";
    case "activity":
      return activitySortExpression(tables);
    case "createdAt":
      return "watch_row.created_at";
    case "updatedAt":
      return "watch_row.updated_at";
    case "disabledAt":
      return "watch_row.disabled_at";
    case "cooldownUntil":
      return "watch_row.cooldown_until";
    default:
      return "watch_row.next_poll_at";
  }
}

function tableMeta(page: number, perPage: number, total: number): ControlWatchesTableMeta {
  return {
    current_page: page,
    last_page: Math.max(1, Math.ceil(total / perPage)),
    total,
    per_page: perPage,
  };
}

function placeholderList(count: number, startAt: number): string {
  return Array.from({length: count}, (_, index) => `$${startAt + index}`).join(", ");
}

function latestRun(row: WatchRow): ControlWatchLatestRun | null {
  if (row.latest_run_id === null || row.latest_run_id === undefined) return null;
  return {
    id: requiredString(row.latest_run_id, "Watch latest run id"),
    status: requiredString(row.latest_run_status, "Watch latest run status") as WatchRunStatus,
    scheduledFor: toIso(row.latest_run_scheduled_for, "Watch latest run scheduled_for"),
    startedAt: optionalIso(row.latest_run_started_at, "Watch latest run started_at"),
    finishedAt: optionalIso(row.latest_run_finished_at, "Watch latest run finished_at"),
    createdAt: toIso(row.latest_run_created_at, "Watch latest run created_at"),
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function publicWatch(row: WatchRow): ControlWatch {
  const sourceConfig = recordValue(row.source_config);
  const detectorConfig = recordValue(row.detector_config);
  const resultConfig = recordValue(sourceConfig?.result);
  return {
    id: requiredString(row.id, "Watch id"),
    title: requiredString(row.title, "Watch title"),
    sourceKind: optionalKind(sourceConfig?.kind, ["mongodb_query", "sql_query", "http_json", "http_html", "imap_mailbox"] as const),
    detectorKind: optionalKind(detectorConfig?.kind, ["new_items", "snapshot_changed", "percent_change"] as const),
    observationKind: optionalKind(resultConfig?.observation, ["collection", "snapshot", "scalar"] as const),
    intervalMinutes: requiredNumber(row.interval_minutes, "Watch interval_minutes"),
    enabled: row.enabled === true,
    lifecycleStatus: lifecycleStatus(row),
    nextPollAt: optionalIso(row.next_poll_at, "Watch next_poll_at"),
    disabledAt: optionalIso(row.disabled_at, "Watch disabled_at"),
    cooldownUntil: optionalIso(row.cooldown_until, "Watch cooldown_until"),
    createdAt: toIso(row.created_at, "Watch created_at"),
    updatedAt: toIso(row.updated_at, "Watch updated_at"),
    recentRunCount: requiredNumber(row.recent_run_count ?? 0, "Watch recent run count"),
    eventCount: requiredNumber(row.event_count ?? 0, "Watch event count"),
    latestRun: latestRun(row),
  };
}

function publicWatchRecord(record: WatchRecord): ControlWatch {
  return {
    id: record.id,
    title: record.title,
    sourceKind: record.source.kind,
    detectorKind: record.detector.kind,
    observationKind: "result" in record.source ? record.source.result.observation : null,
    intervalMinutes: record.intervalMinutes,
    enabled: record.enabled,
    lifecycleStatus: record.disabledAt || !record.enabled ? "disabled" : record.claimedAt ? "running" : record.cooldownUntil ? "cooldown" : "enabled",
    nextPollAt: optionalIso(record.nextPollAt, "Watch nextPollAt"),
    disabledAt: optionalIso(record.disabledAt, "Watch disabledAt"),
    cooldownUntil: optionalIso(record.cooldownUntil, "Watch cooldownUntil"),
    createdAt: toIso(record.createdAt, "Watch createdAt"),
    updatedAt: toIso(record.updatedAt, "Watch updatedAt"),
    recentRunCount: 0,
    eventCount: 0,
    latestRun: null,
  };
}

function optionalInputString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalInputBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function optionalInputPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

export class ControlWatchesService {
  private readonly pool: PgQueryable;
  private readonly store: ControlWatchStore;
  private readonly agents = buildAgentTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private readonly control = buildControlTableNames();
  private readonly watches = buildWatchTableNames();

  constructor(options: {pool: PgQueryable; store: ControlWatchStore}) {
    this.pool = options.pool;
    this.store = options.store;
  }

  private async assertCanAccess(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<void> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const result = await this.pool.query(`
      SELECT 1
      FROM ${this.sessionTables.sessions} AS target_session
      INNER JOIN ${this.control.grants} AS grant_row
        ON grant_row.identity_id = $1
       AND grant_row.active = TRUE
       AND grant_row.role = $4
       AND (grant_row.role = 'admin' OR grant_row.agent_key = target_session.agent_key)
      LEFT JOIN ${this.agents.agentPairings} AS pairing
        ON pairing.agent_key = target_session.agent_key
       AND pairing.identity_id = $1
      WHERE target_session.id = $2
        AND target_session.agent_key = $3
        AND (grant_row.role = 'admin' OR pairing.identity_id IS NOT NULL)
      LIMIT 1
    `, [session.identityId, normalizedSessionId, normalizedAgentKey, session.role]);
    if (result.rows.length === 0) {
      throw new Error("Control watches target session was not found or is not visible.");
    }
  }

  async getWatches(session: ControlSessionRecord, agentKey: string, targetSessionId: string, input: GetWatchesInput = {}): Promise<ControlWatchesRecord> {
    const {page, perPage} = pageInput(input);
    const search = normalizeSearch(input.search);
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const countWhere = ["session_id = $1"];
    const pageWhere = ["watch_row.session_id = $1"];
    const values: unknown[] = [normalizedSessionId];
    if (search) {
      values.push(`%${search}%`);
      const searchParam = `$${values.length}`;
      countWhere.push(`(
        id::text ILIKE ${searchParam}
        OR title ILIKE ${searchParam}
        OR COALESCE(${sourceKindExpression()}, '') ILIKE ${searchParam}
        OR COALESCE(${detectorKindExpression()}, '') ILIKE ${searchParam}
      )`);
      pageWhere.push(`(
        watch_row.id::text ILIKE ${searchParam}
        OR watch_row.title ILIKE ${searchParam}
        OR COALESCE(${sourceKindExpression("watch_row")}, '') ILIKE ${searchParam}
        OR COALESCE(${detectorKindExpression("watch_row")}, '') ILIKE ${searchParam}
      )`);
    }
    if (input.lifecycleStatus) {
      values.push(input.lifecycleStatus);
      countWhere.push(`${lifecycleStatusExpression()} = $${values.length}`);
      pageWhere.push(`${lifecycleStatusExpression("watch_row")} = $${values.length}`);
    }
    if (input.sourceKind) {
      values.push(input.sourceKind);
      countWhere.push(`${sourceKindExpression()} = $${values.length}`);
      pageWhere.push(`${sourceKindExpression("watch_row")} = $${values.length}`);
    }
    const countWhereClause = countWhere.join("\n        AND ");
    const pageWhereClause = pageWhere.join("\n        AND ");
    const countResult = await this.pool.query(`
      SELECT COUNT(*)::INTEGER AS count
      FROM ${this.watches.watches}
      WHERE ${countWhereClause}
    `, values);
    const total = Number((countResult.rows[0] as Record<string, unknown> | undefined)?.count ?? 0);
    values.push(perPage, (page - 1) * perPage);
    const direction = input.sortDirection === "desc" ? "DESC" : "ASC";

    const result = await this.pool.query(`
      SELECT
        watch_row.id,
        watch_row.title,
        watch_row.source_config,
        watch_row.detector_config,
        watch_row.interval_minutes,
        watch_row.enabled,
        watch_row.claimed_at,
        watch_row.next_poll_at,
        watch_row.disabled_at,
        watch_row.cooldown_until,
        watch_row.created_at,
        watch_row.updated_at
      FROM ${this.watches.watches} AS watch_row
      WHERE ${pageWhereClause}
      ORDER BY ${sortExpression(input.sortBy, this.watches)} ${direction} NULLS LAST, watch_row.id ASC
      LIMIT $${values.length - 1}
      OFFSET $${values.length}
    `, values);

    const rows = result.rows as WatchRow[];
    const watchIds = rows.map((row) => requiredString(row.id, "Watch id"));
    if (watchIds.length > 0) {
      const idPlaceholders = placeholderList(watchIds.length, 2);
      const runCounts = await this.pool.query(`
        SELECT watch_id, COUNT(*)::INTEGER AS count
        FROM ${this.watches.watchRuns}
        WHERE session_id = $1
          AND watch_id IN (${idPlaceholders})
          AND created_at >= NOW() - INTERVAL '30 days'
        GROUP BY watch_id
      `, [normalizedSessionId, ...watchIds]);
      const eventCounts = await this.pool.query(`
        SELECT watch_id, COUNT(*)::INTEGER AS count
        FROM ${this.watches.watchEvents}
        WHERE session_id = $1
          AND watch_id IN (${idPlaceholders})
        GROUP BY watch_id
      `, [normalizedSessionId, ...watchIds]);
      const latestRuns = await this.pool.query(`
        SELECT
          watch_id,
          id AS latest_run_id,
          status AS latest_run_status,
          scheduled_for AS latest_run_scheduled_for,
          started_at AS latest_run_started_at,
          finished_at AS latest_run_finished_at,
          created_at AS latest_run_created_at
        FROM ${this.watches.watchRuns}
        WHERE session_id = $1
          AND watch_id IN (${idPlaceholders})
        ORDER BY watch_id ASC, created_at DESC, id ASC
      `, [normalizedSessionId, ...watchIds]);
      const runCountByWatchId = new Map((runCounts.rows as WatchRow[]).map((row) => [requiredString(row.watch_id, "Watch run count watch id"), row.count]));
      const eventCountByWatchId = new Map((eventCounts.rows as WatchRow[]).map((row) => [requiredString(row.watch_id, "Watch event count watch id"), row.count]));
      const latestByWatchId = new Map<string, WatchRow>();
      for (const row of latestRuns.rows as WatchRow[]) {
        const watchId = requiredString(row.watch_id, "Watch latest run watch id");
        if (!latestByWatchId.has(watchId)) latestByWatchId.set(watchId, row);
      }
      for (const row of rows) {
        const watchId = requiredString(row.id, "Watch id");
        row.recent_run_count = runCountByWatchId.get(watchId) ?? 0;
        row.event_count = eventCountByWatchId.get(watchId) ?? 0;
        Object.assign(row, latestByWatchId.get(watchId) ?? {});
      }
    }

    const data = rows.map(publicWatch);

    return {
      agentKey: normalizedAgentKey,
      sessionId: normalizedSessionId,
      data,
      meta: tableMeta(page, perPage, total),
      watches: data,
    };
  }

  async updateWatch(
    session: ControlSessionRecord,
    agentKey: string,
    targetSessionId: string,
    watchId: string,
    input: UpdateControlWatchInput,
  ): Promise<ControlWatchWriteResult> {
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const normalizedWatchId = requireNonEmptyString(watchId, "Watch id is required.");
    const title = optionalInputString(input.title, "Watch title");
    const intervalMinutes = optionalInputPositiveInteger(input.intervalMinutes, "Watch interval minutes");
    const enabled = optionalInputBoolean(input.enabled, "Watch enabled");
    const updated = await this.store.updateWatch({
      watchId: normalizedWatchId,
      sessionId: normalizedSessionId,
      ...(title !== undefined ? {title} : {}),
      ...(intervalMinutes !== undefined ? {intervalMinutes} : {}),
      ...(enabled !== undefined ? {enabled} : {}),
    });

    return {
      watch: publicWatchRecord(updated),
      audit: {
        action: "update_watch",
        agentKey: normalizedAgentKey,
        targetSessionId: normalizedSessionId,
        watchId: updated.id,
        ...(title !== undefined ? {title} : {}),
        ...(intervalMinutes !== undefined ? {intervalMinutes} : {}),
        ...(enabled !== undefined ? {enabled} : {}),
      },
    };
  }

  async disableWatch(
    session: ControlSessionRecord,
    agentKey: string,
    targetSessionId: string,
    watchId: string,
    input: DisableControlWatchInput = {},
  ): Promise<ControlWatchWriteResult> {
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const normalizedWatchId = requireNonEmptyString(watchId, "Watch id is required.");
    const reason = optionalInputString(input.reason, "Watch disable reason");
    const disabled = await this.store.disableWatch({
      watchId: normalizedWatchId,
      sessionId: normalizedSessionId,
      ...(reason ? {reason} : {}),
    });

    return {
      watch: publicWatchRecord(disabled),
      audit: {
        action: "disable_watch",
        agentKey: normalizedAgentKey,
        targetSessionId: normalizedSessionId,
        watchId: disabled.id,
        ...(reason ? {reason: {length: reason.length}} : {}),
      },
    };
  }
}
