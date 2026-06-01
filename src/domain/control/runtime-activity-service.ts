import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import type {ThreadRunStatus} from "../threads/runtime/types.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

const DEFAULT_RUN_LIMIT = 25;
const MAX_RUN_LIMIT = 100;

const FAILURE_CATEGORY_TOKENS = [
  "provider_abort",
  "provider_timeout",
  "provider_server_error",
  "provider_transport_terminated",
  "provider_transport_network",
  "provider_error",
] as const;

export type ControlRuntimeFailureCategory = typeof FAILURE_CATEGORY_TOKENS[number];

export interface ControlRuntimeActivityRun {
  id: string;
  status: ThreadRunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  abortRequestedAt: string | null;
  failureCategory: ControlRuntimeFailureCategory | null;
}

export interface ControlRuntimeActivitySummary {
  running: number;
  completed: number;
  failed: number;
  latestStartedAt: string | null;
  latestFinishedAt: string | null;
}

export interface ControlRuntimeActivityRecord {
  agentKey: string;
  sessionId: string;
  summary: ControlRuntimeActivitySummary;
  runs: readonly ControlRuntimeActivityRun[];
}

export interface GetRuntimeActivityInput {
  limit?: number;
}

type RunRow = Record<string, unknown>;

function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_RUN_LIMIT;
  if (!Number.isInteger(value) || value < 1) throw new Error("Control runtime activity limit must be a positive integer.");
  return Math.min(MAX_RUN_LIMIT, value);
}

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

function failureCategory(error: unknown): ControlRuntimeFailureCategory | null {
  if (typeof error !== "string") return null;
  for (const token of FAILURE_CATEGORY_TOKENS) {
    if (error.includes(`failureKind=${token}`)) return token;
  }
  return null;
}

function publicRun(row: RunRow): ControlRuntimeActivityRun {
  const startedAt = toIso(row.started_at, "Runtime run started_at");
  const finishedAt = optionalIso(row.finished_at, "Runtime run finished_at");
  const durationMs = finishedAt ? new Date(finishedAt).getTime() - new Date(startedAt).getTime() : null;
  return {
    id: requiredString(row.id, "Runtime run id"),
    status: requiredString(row.status, "Runtime run status") as ThreadRunStatus,
    startedAt,
    finishedAt,
    durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
    abortRequestedAt: optionalIso(row.abort_requested_at, "Runtime run abort_requested_at"),
    failureCategory: failureCategory(row.error),
  };
}

function summaryFromRuns(runs: readonly ControlRuntimeActivityRun[]): ControlRuntimeActivitySummary {
  const summary: ControlRuntimeActivitySummary = {
    running: 0,
    completed: 0,
    failed: 0,
    latestStartedAt: null,
    latestFinishedAt: null,
  };
  for (const run of runs) {
    if (run.status === "running") summary.running += 1;
    if (run.status === "completed") summary.completed += 1;
    if (run.status === "failed") summary.failed += 1;
    if (!summary.latestStartedAt || run.startedAt > summary.latestStartedAt) summary.latestStartedAt = run.startedAt;
    if (run.finishedAt && (!summary.latestFinishedAt || run.finishedAt > summary.latestFinishedAt)) summary.latestFinishedAt = run.finishedAt;
  }
  return summary;
}

export class ControlRuntimeActivityService {
  private readonly pool: PgQueryable;
  private readonly agents = buildAgentTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private readonly control = buildControlTableNames();
  private readonly threads = buildThreadRuntimeTableNames();

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
      throw new Error("Control runtime activity target session was not found or is not visible.");
    }
  }

  async getRuntimeActivity(session: ControlSessionRecord, agentKey: string, targetSessionId: string, input: GetRuntimeActivityInput = {}): Promise<ControlRuntimeActivityRecord> {
    const limit = parseLimit(input.limit);
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");

    const result = await this.pool.query(`
      SELECT
        run.id,
        run.status,
        run.started_at,
        run.finished_at,
        run.abort_requested_at,
        run.error
      FROM ${this.threads.runs} AS run
      INNER JOIN ${this.threads.threads} AS thread
        ON thread.id = run.thread_id
      INNER JOIN ${this.sessionTables.sessions} AS target_session
        ON target_session.id = thread.session_id
      WHERE target_session.id = $1
        AND target_session.agent_key = $2
      ORDER BY run.started_at DESC, run.id ASC
      LIMIT $3
    `, [normalizedSessionId, normalizedAgentKey, limit]);

    const runs = (result.rows as RunRow[]).map(publicRun);
    return {
      agentKey: normalizedAgentKey,
      sessionId: normalizedSessionId,
      summary: summaryFromRuns(runs),
      runs,
    };
  }
}
