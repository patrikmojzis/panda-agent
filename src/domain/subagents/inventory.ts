import {readOptionalJsonValue} from "../../lib/json.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {collapseWhitespace, optionalTrimmedString, requireNonEmptyString, truncateText} from "../../lib/strings.js";
import {summarizeRuntimeError} from "../../lib/runtime-error-summary.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../execution-environments/filesystem.js";
import {buildExecutionEnvironmentTableNames} from "../execution-environments/postgres-shared.js";
import type {ExecutionEnvironmentState} from "../execution-environments/types.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import type {ThreadRunStatus} from "../threads/runtime/types.js";
import type {SubagentExecutionMode} from "./session-metadata.js";

const TASK_PREVIEW_CHARS = 240;

export type SubagentInventoryRunStatusFilter = ThreadRunStatus | "all";

export interface SubagentInventoryRun {
  id: string;
  status: ThreadRunStatus;
  startedAt: string;
  finishedAt: string | null;
  errorSummary: string | null;
}

export interface SubagentInventoryEnvironment {
  id: string;
  alias: string | null;
  state: ExecutionEnvironmentState | null;
  runnerCwd: string | null;
  rootPath: string | null;
  expiresAt: string | null;
  paths: {
    root?: string;
    workspace?: string;
    inbox?: string;
    artifacts?: string;
  } | null;
}

export interface SubagentInventoryRecord {
  sessionId: string;
  currentThreadId: string;
  profile: string;
  execution: SubagentExecutionMode;
  taskPreview: string;
  startedAt: string;
  messageCount: number;
  pendingInputCount: number;
  lastMessageAt: string | null;
  latestRun: SubagentInventoryRun | null;
  environment: SubagentInventoryEnvironment | null;
}

export interface ListSubagentInventoryInput {
  agentKey: string;
  parentSessionId: string;
  runStatus: SubagentInventoryRunStatusFilter;
  limit: number;
}

export interface ShowSubagentInventoryInput {
  agentKey: string;
  parentSessionId: string;
  sessionId: string;
}

export interface SubagentInventoryReader {
  list(input: ListSubagentInventoryInput): Promise<{
    records: readonly SubagentInventoryRecord[];
    hasMore: boolean;
  }>;
  show(input: ShowSubagentInventoryInput): Promise<SubagentInventoryRecord | null>;
}

function toIso(value: unknown, label: string): string {
  return new Date(requireTimestampMillis(value, `${label} must be a valid timestamp.`)).toISOString();
}

function optionalIso(value: unknown, label: string): string | null {
  const millis = optionalTimestampMillis(value, `${label} must be a valid timestamp.`);
  return millis === undefined ? null : new Date(millis).toISOString();
}

function requireCount(value: unknown, label: string): number {
  const count = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : Number.NaN;
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return count;
}

function parseExecution(value: unknown): SubagentExecutionMode {
  if (value === "agent_workspace" || value === "isolated_environment") {
    return value;
  }
  throw new Error(`Unsupported subagent inventory execution mode ${String(value)}.`);
}

function parseRunStatus(value: unknown): ThreadRunStatus {
  if (value === "running" || value === "completed" || value === "failed") {
    return value;
  }
  throw new Error(`Unsupported subagent inventory run status ${String(value)}.`);
}

function parseEnvironmentState(value: unknown): ExecutionEnvironmentState | null {
  if (value === null || value === undefined) return null;
  if (
    value === "provisioning"
    || value === "ready"
    || value === "failed"
    || value === "stopping"
    || value === "stopped"
  ) {
    return value;
  }
  throw new Error(`Unsupported subagent inventory environment state ${String(value)}.`);
}

function readPaths(metadata: unknown): SubagentInventoryEnvironment["paths"] {
  const filesystem = readExecutionEnvironmentFilesystemMetadata(
    readOptionalJsonValue(metadata, "Subagent inventory environment metadata"),
  );
  if (!filesystem) return null;

  const paths = {
    ...(filesystem.root.parentRunnerPath ? {root: filesystem.root.parentRunnerPath} : {}),
    ...(filesystem.workspace.parentRunnerPath ? {workspace: filesystem.workspace.parentRunnerPath} : {}),
    ...(filesystem.inbox.parentRunnerPath ? {inbox: filesystem.inbox.parentRunnerPath} : {}),
    ...(filesystem.artifacts.parentRunnerPath ? {artifacts: filesystem.artifacts.parentRunnerPath} : {}),
  };
  return Object.keys(paths).length > 0 ? paths : null;
}

function parseInventoryRow(row: Record<string, unknown>): SubagentInventoryRecord {
  const execution = parseExecution(row.execution);
  const environmentId = optionalTrimmedString(
    row.environment_id,
    "Subagent inventory environment id must be a string.",
  );
  if (execution === "isolated_environment" && !environmentId) {
    throw new Error("Isolated subagent inventory row must include an environment id.");
  }

  const latestRun = row.run_id === null || row.run_id === undefined
    ? null
    : {
      id: requireNonEmptyString(row.run_id, "Subagent inventory run id must not be empty."),
      status: parseRunStatus(row.run_status),
      startedAt: toIso(row.run_started_at, "Subagent inventory run started_at"),
      finishedAt: optionalIso(row.run_finished_at, "Subagent inventory run finished_at"),
      errorSummary: row.run_status === "failed" ? summarizeRuntimeError(row.run_error) : null,
    } satisfies SubagentInventoryRun;

  return {
    sessionId: requireNonEmptyString(row.session_id, "Subagent inventory session id must not be empty."),
    currentThreadId: requireNonEmptyString(row.current_thread_id, "Subagent inventory current thread id must not be empty."),
    profile: requireNonEmptyString(row.profile, "Subagent inventory profile must not be empty."),
    execution,
    taskPreview: truncateText(collapseWhitespace(
      requireNonEmptyString(row.task, "Subagent inventory task must not be empty."),
    ), TASK_PREVIEW_CHARS),
    startedAt: toIso(row.session_started_at, "Subagent inventory session started_at"),
    messageCount: requireCount(row.message_count, "Subagent inventory message count"),
    pendingInputCount: requireCount(row.pending_input_count, "Subagent inventory pending input count"),
    lastMessageAt: optionalIso(row.last_message_at, "Subagent inventory last_message_at"),
    latestRun,
    environment: environmentId
      ? {
        id: environmentId,
        alias: optionalTrimmedString(
          row.environment_alias,
          "Subagent inventory environment alias must be a string.",
        ) ?? null,
        state: parseEnvironmentState(row.environment_state),
        runnerCwd: optionalTrimmedString(
          row.environment_runner_cwd,
          "Subagent inventory environment runner cwd must be a string.",
        ) ?? null,
        rootPath: optionalTrimmedString(
          row.environment_root_path,
          "Subagent inventory environment root path must be a string.",
        ) ?? null,
        expiresAt: optionalIso(row.environment_expires_at, "Subagent inventory environment expires_at"),
        paths: readPaths(row.environment_metadata),
      }
      : null,
  };
}

export class PostgresSubagentInventory implements SubagentInventoryReader {
  private readonly queryable: PgQueryable;

  constructor(queryable: PgQueryable) {
    this.queryable = queryable;
  }

  async list(input: ListSubagentInventoryInput): Promise<{
    records: readonly SubagentInventoryRecord[];
    hasMore: boolean;
  }> {
    const rows = await this.query({...input, sessionId: null, queryLimit: input.limit + 1});
    return {
      records: rows.slice(0, input.limit),
      hasMore: rows.length > input.limit,
    };
  }

  async show(input: ShowSubagentInventoryInput): Promise<SubagentInventoryRecord | null> {
    const rows = await this.query({
      ...input,
      runStatus: "all",
      queryLimit: 1,
    });
    return rows[0] ?? null;
  }

  private async query(input: {
    agentKey: string;
    parentSessionId: string;
    runStatus: SubagentInventoryRunStatusFilter;
    sessionId: string | null;
    queryLimit: number;
  }): Promise<SubagentInventoryRecord[]> {
    const sessionTables = buildSessionTableNames();
    const threadTables = buildThreadRuntimeTableNames();
    const environmentTables = buildExecutionEnvironmentTableNames();
    const result = await this.queryable.query(`
      WITH scoped_sessions AS (
        SELECT
          subagent.id AS session_id,
          subagent.current_thread_id,
          subagent.created_at AS session_started_at,
          subagent.metadata->'subagent'->'profile'->>'slug' AS profile,
          subagent.metadata->'subagent'->>'execution' AS execution,
          subagent.metadata->'subagent'->>'task' AS task,
          subagent.metadata->'subagent'->>'environmentId' AS environment_id
        FROM ${sessionTables.sessions} AS subagent
        WHERE subagent.agent_key = $1
          AND subagent.kind = 'subagent'
          AND subagent.metadata->'subagent'->>'parentSessionId' = $2
          AND ($4::TEXT IS NULL OR subagent.id = $4)
      ),
      latest_runs AS (
        SELECT DISTINCT ON (thread.session_id)
          thread.session_id,
          run.id,
          run.status,
          run.started_at,
          run.finished_at,
          run.error
        FROM ${threadTables.runs} AS run
        INNER JOIN ${threadTables.threads} AS thread ON thread.id = run.thread_id
        INNER JOIN scoped_sessions ON scoped_sessions.session_id = thread.session_id
        ORDER BY thread.session_id ASC, run.started_at DESC, run.id DESC
      ),
      scoped_subagents AS (
        SELECT
          scoped_sessions.*,
          latest_run.id AS run_id,
          latest_run.status AS run_status,
          latest_run.started_at AS run_started_at,
          latest_run.finished_at AS run_finished_at,
          latest_run.error AS run_error
        FROM scoped_sessions
        LEFT JOIN latest_runs AS latest_run ON latest_run.session_id = scoped_sessions.session_id
        WHERE $3::TEXT = 'all' OR latest_run.status = $3
        ORDER BY
          CASE latest_run.status
            WHEN 'running' THEN 1
            WHEN 'failed' THEN 2
            WHEN 'completed' THEN 3
            ELSE 0
          END ASC,
          COALESCE(latest_run.started_at, scoped_sessions.session_started_at) DESC,
          scoped_sessions.session_id ASC
        LIMIT $5
      ),
      message_summaries AS (
        SELECT
          thread.session_id,
          COUNT(message.id)::INTEGER AS message_count,
          MAX(message.created_at) AS last_message_at
        FROM ${threadTables.messages} AS message
        INNER JOIN ${threadTables.threads} AS thread ON thread.id = message.thread_id
        INNER JOIN scoped_subagents ON scoped_subagents.session_id = thread.session_id
        GROUP BY thread.session_id
      ),
      pending_summaries AS (
        SELECT
          input.thread_id,
          COUNT(input.id)::INTEGER AS pending_input_count
        FROM ${threadTables.inputs} AS input
        INNER JOIN scoped_subagents ON scoped_subagents.current_thread_id = input.thread_id
        WHERE input.applied_at IS NULL
        GROUP BY input.thread_id
      )
      SELECT
        scoped_subagents.*,
        COALESCE(message_summaries.message_count, 0)::INTEGER AS message_count,
        message_summaries.last_message_at,
        COALESCE(pending_summaries.pending_input_count, 0)::INTEGER AS pending_input_count,
        binding.alias AS environment_alias,
        environment.state AS environment_state,
        environment.runner_cwd AS environment_runner_cwd,
        environment.root_path AS environment_root_path,
        environment.expires_at AS environment_expires_at,
        environment.metadata AS environment_metadata
      FROM scoped_subagents
      LEFT JOIN message_summaries ON message_summaries.session_id = scoped_subagents.session_id
      LEFT JOIN pending_summaries ON pending_summaries.thread_id = scoped_subagents.current_thread_id
      LEFT JOIN ${environmentTables.sessionEnvironmentBindings} AS binding
        ON binding.session_id = scoped_subagents.session_id
       AND binding.environment_id = scoped_subagents.environment_id
      LEFT JOIN ${environmentTables.executionEnvironments} AS environment
        ON environment.id = scoped_subagents.environment_id
       AND environment.agent_key = $1
       AND environment.created_by_session_id = $2
      ORDER BY
        CASE scoped_subagents.run_status
          WHEN 'running' THEN 1
          WHEN 'failed' THEN 2
          WHEN 'completed' THEN 3
          ELSE 0
        END ASC,
        COALESCE(scoped_subagents.run_started_at, scoped_subagents.session_started_at) DESC,
        scoped_subagents.session_id ASC
    `, [
      requireNonEmptyString(input.agentKey, "Subagent inventory agent key must not be empty."),
      requireNonEmptyString(input.parentSessionId, "Subagent inventory parent session id must not be empty."),
      input.runStatus,
      input.sessionId,
      input.queryLimit,
    ]);

    return result.rows.map((row) => parseInventoryRow(row as Record<string, unknown>));
  }
}
