import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildWatchTableNames} from "../watches/postgres-shared.js";
import type {WatchObservationKind, WatchRunStatus, WatchSourceKind} from "../watches/types.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

const DEFAULT_WATCH_LIMIT = 50;
const MAX_WATCH_LIMIT = 100;

export type ControlWatchDetectorKind = "new_items" | "snapshot_changed" | "percent_change";
export type ControlWatchLifecycleStatus = "enabled" | "disabled" | "cooldown" | "running";

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
  watches: readonly ControlWatch[];
}

export interface GetWatchesInput {
  limit?: number;
}

type WatchRow = Record<string, unknown>;

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

function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WATCH_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw new Error("Control watches limit must be a positive integer.");
  return Math.min(MAX_WATCH_LIMIT, value);
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

export class ControlWatchesService {
  private readonly pool: PgQueryable;
  private readonly agents = buildAgentTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private readonly control = buildControlTableNames();
  private readonly watches = buildWatchTableNames();

  constructor(options: {pool: PgQueryable}) {
    this.pool = options.pool;
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
    const limit = parseLimit(input.limit);
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");

    const result = await this.pool.query(`
      SELECT
        id,
        title,
        source_config,
        detector_config,
        interval_minutes,
        enabled,
        claimed_at,
        next_poll_at,
        disabled_at,
        cooldown_until,
        created_at,
        updated_at
      FROM ${this.watches.watches}
      WHERE session_id = $1
      ORDER BY next_poll_at ASC NULLS LAST, created_at DESC, id ASC
      LIMIT $2
    `, [normalizedSessionId, limit]);

    const rows = result.rows as WatchRow[];
    for (const row of rows) {
      const watchId = requiredString(row.id, "Watch id");
      const recentRuns = await this.pool.query(`
        SELECT COUNT(*)::INTEGER AS count
        FROM ${this.watches.watchRuns}
        WHERE session_id = $1
          AND watch_id = $2
          AND created_at >= NOW() - INTERVAL '30 days'
      `, [normalizedSessionId, watchId]);
      const events = await this.pool.query(`
        SELECT COUNT(*)::INTEGER AS count
        FROM ${this.watches.watchEvents}
        WHERE session_id = $1
          AND watch_id = $2
      `, [normalizedSessionId, watchId]);
      row.recent_run_count = (recentRuns.rows[0] as Record<string, unknown> | undefined)?.count ?? 0;
      row.event_count = (events.rows[0] as Record<string, unknown> | undefined)?.count ?? 0;

      const latest = await this.pool.query(`
        SELECT
          id AS latest_run_id,
          status AS latest_run_status,
          scheduled_for AS latest_run_scheduled_for,
          started_at AS latest_run_started_at,
          finished_at AS latest_run_finished_at,
          created_at AS latest_run_created_at
        FROM ${this.watches.watchRuns}
        WHERE session_id = $1
          AND watch_id = $2
        ORDER BY created_at DESC, id ASC
        LIMIT 1
      `, [normalizedSessionId, watchId]);
      Object.assign(row, latest.rows[0] ?? {});
    }

    return {
      agentKey: normalizedAgentKey,
      sessionId: normalizedSessionId,
      watches: rows.map(publicWatch),
    };
  }
}
