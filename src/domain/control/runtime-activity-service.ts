import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import type {ThreadRunStatus} from "../threads/runtime/types.js";
import {buildControlTableNames} from "./postgres-shared.js";
import {summarizeRuntimeError} from "./runtime-error-summary.js";
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
  errorSummary: string | null;
}

export interface ControlRuntimeActivitySummary {
  total: number;
  running: number;
  completed: number;
  failed: number;
  abortRequests: number;
  averageDurationMs: number | null;
  latestStartedAt: string | null;
  latestFinishedAt: string | null;
  latestRun: ControlRuntimeActivityRun | null;
}

export type ControlRuntimeSortDirection = "asc" | "desc";

export interface ControlRuntimeActivityTableInput {
  page?: number;
  perPage?: number;
  sortBy?: string;
  sortDirection?: ControlRuntimeSortDirection;
  search?: string;
  status?: string;
  failureCategory?: ControlRuntimeFailureCategory;
  limit?: number;
}

export interface ControlRuntimeActivityTableMeta {
  current_page: number;
  last_page: number;
  total: number;
  per_page: number;
}

export interface ControlRuntimeActivityRecord {
  agentKey: string;
  sessionId: string;
  summary: ControlRuntimeActivitySummary;
  data: readonly ControlRuntimeActivityRun[];
  meta: ControlRuntimeActivityTableMeta;
}

type RunRow = Record<string, unknown>;

function pageInput(input: ControlRuntimeActivityTableInput): {page: number; perPage: number} {
  const page = input.page ?? 1;
  const perPage = input.perPage ?? input.limit ?? DEFAULT_RUN_LIMIT;
  if (!Number.isInteger(page) || page < 1) throw new Error("Control runtime activity page must be a positive integer.");
  if (!Number.isInteger(perPage) || perPage < 1) throw new Error("Control runtime activity per_page must be a positive integer.");
  return {page, perPage: Math.min(MAX_RUN_LIMIT, perPage)};
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
  const status = requiredString(row.status, "Runtime run status") as ThreadRunStatus;
  return {
    id: requiredString(row.id, "Runtime run id"),
    status,
    startedAt,
    finishedAt,
    durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
    abortRequestedAt: optionalIso(row.abort_requested_at, "Runtime run abort_requested_at"),
    failureCategory: failureCategory(row.error),
    errorSummary: status === "failed" ? summarizeRuntimeError(row.error) : null,
  };
}

function summaryFromRuns(runs: readonly ControlRuntimeActivityRun[]): ControlRuntimeActivitySummary {
  const durations = runs
    .map((run) => run.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const summary: ControlRuntimeActivitySummary = {
    total: runs.length,
    running: 0,
    completed: 0,
    failed: 0,
    abortRequests: 0,
    averageDurationMs: durations.length > 0 ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null,
    latestStartedAt: null,
    latestFinishedAt: null,
    latestRun: null,
  };
  for (const run of runs) {
    if (run.status === "running") summary.running += 1;
    if (run.status === "completed") summary.completed += 1;
    if (run.status === "failed") summary.failed += 1;
    if (run.abortRequestedAt) summary.abortRequests += 1;
    if (!summary.latestStartedAt || run.startedAt > summary.latestStartedAt) summary.latestStartedAt = run.startedAt;
    if (run.finishedAt && (!summary.latestFinishedAt || run.finishedAt > summary.latestFinishedAt)) summary.latestFinishedAt = run.finishedAt;
    if (!summary.latestRun || run.startedAt > summary.latestRun.startedAt) summary.latestRun = run;
  }
  return summary;
}

function normalizedSearch(value: string | undefined): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function runSearchText(run: ControlRuntimeActivityRun): string {
  return [
    run.id,
    run.status,
    run.failureCategory ?? "",
    run.errorSummary ?? "",
    run.startedAt,
    run.finishedAt ?? "",
  ].join(" ").toLowerCase();
}

function runValue(run: ControlRuntimeActivityRun, key: string): unknown {
  if (key === "startedAt") return Date.parse(run.startedAt);
  if (key === "finishedAt") return run.finishedAt ? Date.parse(run.finishedAt) : null;
  return (run as unknown as Record<string, unknown>)[key];
}

function compareRunValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined || left === "") return 1;
  if (right === null || right === undefined || right === "") return -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), undefined, {numeric: true, sensitivity: "base"});
}

function tableRuns(runs: readonly ControlRuntimeActivityRun[], input: ControlRuntimeActivityTableInput): {data: readonly ControlRuntimeActivityRun[]; meta: ControlRuntimeActivityTableMeta} {
  const {page, perPage} = pageInput(input);
  const search = normalizedSearch(input.search);
  const filtered = runs.filter((run) =>
    (!input.status || run.status === input.status)
    && (!input.failureCategory || run.failureCategory === input.failureCategory)
    && (!search || runSearchText(run).includes(search))
  );
  const sortBy = input.sortBy ?? "startedAt";
  const direction = input.sortDirection === "asc" ? 1 : -1;
  const sorted = [...filtered].sort((left, right) =>
    compareRunValues(runValue(left, sortBy), runValue(right, sortBy)) * direction
  );
  const lastPage = Math.max(Math.ceil(sorted.length / perPage), 1);
  const currentPage = Math.min(page, lastPage);
  const start = (currentPage - 1) * perPage;
  return {
    data: sorted.slice(start, start + perPage),
    meta: {
      current_page: currentPage,
      last_page: lastPage,
      total: sorted.length,
      per_page: perPage,
    },
  };
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

  async getRuntimeActivity(session: ControlSessionRecord, agentKey: string, targetSessionId: string, input: ControlRuntimeActivityTableInput = {}): Promise<ControlRuntimeActivityRecord> {
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
    `, [normalizedSessionId, normalizedAgentKey]);

    const runs = (result.rows as RunRow[]).map(publicRun);
    const table = tableRuns(runs, input);
    return {
      agentKey: normalizedAgentKey,
      sessionId: normalizedSessionId,
      summary: summaryFromRuns(runs),
      data: table.data,
      meta: table.meta,
    };
  }
}
