import {lstat, readdir, realpath, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {buildA2ATableNames} from "../../domain/a2a/postgres-shared.js";
import {buildOutboundDeliveryTableNames} from "../../domain/channels/deliveries/postgres-shared.js";
import {
  readExecutionEnvironmentFilesystemMetadata,
} from "../../domain/execution-environments/filesystem.js";
import type {
  ExecutionEnvironmentManager,
  ExecutionEnvironmentRecord,
  ExecutionEnvironmentState,
} from "../../domain/execution-environments/types.js";
import {normalizeExecutionEnvironmentNetworkPolicy} from "../../domain/execution-environments/types.js";
import {buildExecutionEnvironmentTableNames} from "../../domain/execution-environments/postgres-shared.js";
import {buildSessionTableNames} from "../../domain/sessions/postgres-shared.js";
import {buildRuntimeRequestTableNames} from "../../domain/threads/requests/postgres-shared.js";
import {nullableTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {buildThreadRuntimeTableNames} from "../../domain/threads/runtime/postgres-shared.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {requireNonNegativeInteger} from "../../lib/numbers.js";
import type {PgClientLike, PgPoolLike} from "../../lib/postgres-query.js";
import {A2A_CONNECTOR_KEY, A2A_SOURCE} from "../../domain/a2a/constants.js";
import {readOptionalJsonValue, type JsonValue} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import {requireTrimmedString, trimToUndefined, uniqueTrimmedStrings} from "../../lib/strings.js";
import {resolveDataDir} from "./data-dir.js";
import {
  stopExecutionEnvironment,
  type ExecutionEnvironmentStopStore,
} from "./execution-environment-service.js";

export interface SubagentPurgeSelector {
  agentKey?: string;
  sessionId?: string;
  environmentId?: string;
  stopped?: boolean;
  expired?: boolean;
  olderThanMs?: number;
}

export interface SubagentPurgeInput {
  selector: SubagentPurgeSelector;
  execute?: boolean;
  force?: boolean;
  skipFiles?: boolean;
  now?: number;
}

export interface SubagentPurgeDbCounts {
  sessions: number;
  sessionHeartbeats: number;
  threads: number;
  messages: number;
  inputs: number;
  runs: number;
  toolJobs: number;
  bashJobs: number;
  executionEnvironments: number;
  sessionEnvironmentBindings: number;
  a2aSessionBindings: number;
  outboundDeliveries: number;
  runtimeRequests: number;
}

export type SubagentPurgeFilesystemStatus =
  | "safe"
  | "missing"
  | "missing_metadata"
  | "skipped"
  | "unsafe";

export interface SubagentPurgeFilesystemPlan {
  status: SubagentPurgeFilesystemStatus;
  rootPath?: string;
  envDir?: string;
  bytes?: number;
  reason?: string;
}

export interface SubagentPurgeCandidate {
  sessionId: string;
  sessionIds: readonly string[];
  threadIds: readonly string[];
  currentThreadId?: string;
  agentKey: string;
  sessionCreatedAt: number;
  sessionUpdatedAt: number;
  environment: ExecutionEnvironmentRecord;
  containerName?: string;
  filesystem: SubagentPurgeFilesystemPlan;
  dbCounts: SubagentPurgeDbCounts;
  externalFileReferenceCount: number | null;
  refusedReason?: string;
}

export interface SubagentPurgePlan {
  dryRun: boolean;
  now: number;
  candidates: readonly SubagentPurgeCandidate[];
}

export interface SubagentPurgeServiceOptions {
  pool: PgPoolLike;
  environmentStore: ExecutionEnvironmentStopStore;
  manager?: ExecutionEnvironmentManager | null;
  env?: NodeJS.ProcessEnv;
}

interface CandidateRow {
  session_id: string | null;
  session_agent_key: string | null;
  current_thread_id: string | null;
  session_created_at: number | null;
  session_updated_at: number | null;
  environment_id: string;
  environment_agent_key: string;
  kind: ExecutionEnvironmentRecord["kind"];
  state: ExecutionEnvironmentState;
  network_policy: ExecutionEnvironmentRecord["networkPolicy"];
  runner_url: string | null;
  runner_cwd: string | null;
  root_path: string | null;
  created_by_session_id: string | null;
  created_for_session_id: string | null;
  expires_at: number | null;
  metadata: JsonValue | null;
  environment_created_at: number;
  environment_updated_at: number;
}

const STOPPED_PURGE_STATES = new Set<ExecutionEnvironmentState>(["stopped", "failed"]);
const PATH_REFERENCE_KEYS = new Set(["localPath", "path", "stdoutPath", "stderrPath"]);

function requireTrimmed(field: string, value: unknown): string {
  return requireTrimmedString(value, `${field} must be a string.`, `${field} must not be empty.`);
}

function hasSelector(selector: SubagentPurgeSelector): boolean {
  return Boolean(
    trimToUndefined(selector.agentKey)
    || trimToUndefined(selector.sessionId)
    || trimToUndefined(selector.environmentId)
    || selector.stopped
    || selector.expired
    || selector.olderThanMs !== undefined,
  );
}

function parseEnvironmentKind(value: unknown): ExecutionEnvironmentRecord["kind"] {
  if (value === "disposable_container" || value === "persistent_agent_runner" || value === "local") {
    return value;
  }

  throw new Error(`Unsupported execution environment kind ${String(value)}.`);
}

function parseEnvironmentState(value: unknown): ExecutionEnvironmentState {
  if (
    value === "provisioning"
    || value === "ready"
    || value === "failed"
    || value === "stopping"
    || value === "stopped"
  ) {
    return value;
  }

  throw new Error(`Unsupported execution environment state ${String(value)}.`);
}

function parseCandidateMetadata(value: unknown): JsonValue | null {
  return readOptionalJsonValue(value, "Subagent purge environment metadata") ?? null;
}

function nullableString(field: string, value: unknown): string | null {
  return value === null || value === undefined ? null : requireTrimmed(field, value);
}

function parseCandidateRow(row: Record<string, unknown>): CandidateRow {
  return {
    session_id: nullableString("subagent session id", row.session_id),
    session_agent_key: nullableString("subagent session agent key", row.session_agent_key),
    current_thread_id: nullableString("subagent current thread id", row.current_thread_id),
    session_created_at: nullableTimestampMillis(row.session_created_at, "Subagent purge session_created_at must be a valid timestamp."),
    session_updated_at: nullableTimestampMillis(row.session_updated_at, "Subagent purge session_updated_at must be a valid timestamp."),
    environment_id: requireTrimmed("subagent environment id", row.environment_id),
    environment_agent_key: requireTrimmed("subagent environment agent key", row.environment_agent_key),
    kind: parseEnvironmentKind(row.kind),
    state: parseEnvironmentState(row.state),
    network_policy: normalizeExecutionEnvironmentNetworkPolicy(row.network_policy),
    runner_url: nullableString("subagent runner url", row.runner_url),
    runner_cwd: nullableString("subagent runner cwd", row.runner_cwd),
    root_path: nullableString("subagent root path", row.root_path),
    created_by_session_id: nullableString("subagent creator session id", row.created_by_session_id),
    created_for_session_id: nullableString("subagent target session id", row.created_for_session_id),
    expires_at: nullableTimestampMillis(row.expires_at, "Subagent purge expires_at must be a valid timestamp."),
    metadata: parseCandidateMetadata(row.metadata),
    environment_created_at: requireTimestampMillis(row.environment_created_at, "Subagent purge environment_created_at must be a valid timestamp."),
    environment_updated_at: requireTimestampMillis(row.environment_updated_at, "Subagent purge environment_updated_at must be a valid timestamp."),
  };
}

function parseEnvironmentRow(row: CandidateRow): ExecutionEnvironmentRecord {
  return {
    id: row.environment_id,
    agentKey: row.environment_agent_key,
    kind: row.kind,
    state: row.state,
    networkPolicy: row.network_policy,
    ...(row.runner_url ? {runnerUrl: row.runner_url} : {}),
    ...(row.runner_cwd ? {runnerCwd: row.runner_cwd} : {}),
    ...(row.root_path ? {rootPath: row.root_path} : {}),
    ...(row.created_by_session_id ? {createdBySessionId: row.created_by_session_id} : {}),
    ...(row.created_for_session_id ? {createdForSessionId: row.created_for_session_id} : {}),
    ...(row.expires_at === null ? {} : {expiresAt: row.expires_at}),
    ...(row.metadata === null ? {} : {metadata: row.metadata}),
    createdAt: row.environment_created_at,
    updatedAt: row.environment_updated_at,
  };
}

function readContainerName(metadata: JsonValue | undefined): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }
  return trimToUndefined(metadata.containerName);
}

function resolvePathConfigValue(value: string | undefined, fallback: string): string {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return path.resolve(fallback);
  }
  if (trimmed === "~") {
    return os.homedir();
  }
  if (trimmed.startsWith("~/")) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(trimmed);
}

function resolveConfiguredEnvironmentRoots(env: NodeJS.ProcessEnv): readonly string[] {
  const hostRoot = resolvePathConfigValue(
    env.PANDA_ENVIRONMENTS_HOST_ROOT,
    path.join(os.homedir(), ".panda", "environments"),
  );
  const coreRoot = resolvePathConfigValue(
    env.PANDA_CORE_ENVIRONMENTS_ROOT ?? env.PANDA_ENVIRONMENTS_ROOT,
    path.join(resolveDataDir(env), "environments"),
  );
  return [...new Set([hostRoot, coreRoot])];
}

function isStrictPathWithinRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function directoryBytes(targetPath: string): Promise<number> {
  const stat = await lstat(targetPath);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return stat.size;
  }

  const entries = await readdir(targetPath);
  const sizes = await Promise.all(entries.map((entry) => directoryBytes(path.join(targetPath, entry))));
  return stat.size + sizes.reduce((sum, size) => sum + size, 0);
}

async function resolveSafeEnvironmentRoot(input: {
  env: NodeJS.ProcessEnv;
  agentKey: string;
  rootPath: string;
  envDir: string;
}): Promise<{ok: true; rootPath: string} | {ok: false; reason: string}> {
  const candidatePath = path.resolve(input.rootPath);
  if (path.basename(candidatePath) !== input.envDir) {
    return {ok: false, reason: `root basename does not match envDir ${input.envDir}`};
  }

  const roots = resolveConfiguredEnvironmentRoots(input.env);
  for (const configuredRoot of roots) {
    const agentRoot = path.join(configuredRoot, input.agentKey);
    if (!await pathExists(agentRoot)) {
      continue;
    }
    const [realAgentRoot, realCandidate] = await Promise.all([
      realpath(agentRoot),
      realpath(candidatePath),
    ]);
    if (isStrictPathWithinRoot(realAgentRoot, realCandidate)) {
      return {ok: true, rootPath: candidatePath};
    }
  }

  return {ok: false, reason: "root is outside configured Panda environment roots"};
}

function shouldStopEnvironment(environment: ExecutionEnvironmentRecord): boolean {
  return !STOPPED_PURGE_STATES.has(environment.state);
}

function isActiveUnexpiredReady(environment: ExecutionEnvironmentRecord, now: number): boolean {
  return environment.state === "ready"
    && (environment.expiresAt === undefined || environment.expiresAt > now);
}

function collectAbsolutePathReferences(value: unknown, paths: Set<string>): void {
  if (typeof value === "string") {
    if (path.isAbsolute(value)) {
      paths.add(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectAbsolutePathReferences(entry, paths);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (PATH_REFERENCE_KEYS.has(key) && typeof entry === "string" && path.isAbsolute(entry)) {
      paths.add(entry);
    }
    collectAbsolutePathReferences(entry, paths);
  }
}

function countExternalPaths(paths: Set<string>, environmentRootPath: string | undefined): number {
  let count = 0;
  const root = environmentRootPath ? path.resolve(environmentRootPath) : undefined;
  for (const referencedPath of paths) {
    const resolved = path.resolve(referencedPath);
    if (!root || !isStrictPathWithinRoot(root, resolved)) {
      count += 1;
    }
  }
  return count;
}

function buildLikeClause(column: string, needles: readonly string[], values: unknown[]): string {
  const clauses: string[] = [];
  for (const needle of needles) {
    values.push(`%${needle}%`);
    clauses.push(`${column}::text LIKE $${values.length}`);
  }
  return clauses.length === 0 ? "FALSE" : `(${clauses.join(" OR ")})`;
}

function buildTextInClause(column: string, valuesToAdd: readonly string[], values: unknown[]): string {
  if (valuesToAdd.length === 0) {
    return "FALSE";
  }
  const placeholders = valuesToAdd.map((value) => {
    values.push(value);
    return `$${values.length}`;
  });
  return `${column} IN (${placeholders.join(", ")})`;
}

function addValue(values: unknown[], value: unknown): string {
  values.push(value);
  return `$${values.length}`;
}

function jsonTextEquals(column: string, key: string, value: string, values: unknown[]): string {
  return `${column}->>'${key}' = ${addValue(values, value)}`;
}

function nestedJsonTextEquals(
  column: string,
  parentKey: string,
  key: string,
  value: string,
  values: unknown[],
): string {
  return `${column}->'${parentKey}'->>'${key}' = ${addValue(values, value)}`;
}

function buildOutboundDeliverySubagentClause(input: {
  sessionIds: readonly string[];
  threadIds: readonly string[];
}, values: unknown[]): string {
  const clauses: string[] = [];
  if (input.threadIds.length > 0) {
    clauses.push(buildTextInClause("thread_id", input.threadIds, values));
  }
  for (const sessionId of input.sessionIds) {
    clauses.push([
      `channel = ${addValue(values, A2A_SOURCE)}`,
      `connector_key = ${addValue(values, A2A_CONNECTOR_KEY)}`,
      `external_conversation_id = ${addValue(values, sessionId)}`,
    ].join(" AND "));
    clauses.push(nestedJsonTextEquals("metadata", "a2a", "fromSessionId", sessionId, values));
    clauses.push(nestedJsonTextEquals("metadata", "a2a", "toSessionId", sessionId, values));
  }
  for (const threadId of input.threadIds) {
    clauses.push(nestedJsonTextEquals("metadata", "a2a", "fromThreadId", threadId, values));
  }
  return clauses.length === 0 ? "FALSE" : `(${clauses.join(" OR ")})`;
}

function buildRuntimeRequestSubagentClause(input: {
  sessionIds: readonly string[];
  environmentId: string;
  threadIds: readonly string[];
}, values: unknown[]): string {
  const clauses = [
    jsonTextEquals("payload", "environmentId", input.environmentId, values),
    nestedJsonTextEquals("payload", "senderEnvironment", "id", input.environmentId, values),
    jsonTextEquals("result", "environmentId", input.environmentId, values),
  ];
  for (const sessionId of input.sessionIds) {
    clauses.push(jsonTextEquals("payload", "sessionId", sessionId, values));
    clauses.push(jsonTextEquals("payload", "fromSessionId", sessionId, values));
    clauses.push(jsonTextEquals("payload", "toSessionId", sessionId, values));
    clauses.push(jsonTextEquals("result", "sessionId", sessionId, values));
  }
  for (const threadId of input.threadIds) {
    clauses.push(jsonTextEquals("payload", "threadId", threadId, values));
    clauses.push(jsonTextEquals("payload", "fromThreadId", threadId, values));
    clauses.push(jsonTextEquals("result", "threadId", threadId, values));
  }
  return `(${clauses.join(" OR ")})`;
}

function emptyCounts(): SubagentPurgeDbCounts {
  return {
    sessions: 0,
    sessionHeartbeats: 0,
    threads: 0,
    messages: 0,
    inputs: 0,
    runs: 0,
    toolJobs: 0,
    bashJobs: 0,
    executionEnvironments: 0,
    sessionEnvironmentBindings: 0,
    a2aSessionBindings: 0,
    outboundDeliveries: 0,
    runtimeRequests: 0,
  };
}

function sumCounts(left: SubagentPurgeDbCounts, right: SubagentPurgeDbCounts): SubagentPurgeDbCounts {
  return {
    sessions: left.sessions + right.sessions,
    sessionHeartbeats: left.sessionHeartbeats + right.sessionHeartbeats,
    threads: left.threads + right.threads,
    messages: left.messages + right.messages,
    inputs: left.inputs + right.inputs,
    runs: left.runs + right.runs,
    toolJobs: left.toolJobs + right.toolJobs,
    bashJobs: left.bashJobs + right.bashJobs,
    executionEnvironments: left.executionEnvironments + right.executionEnvironments,
    sessionEnvironmentBindings: left.sessionEnvironmentBindings + right.sessionEnvironmentBindings,
    a2aSessionBindings: left.a2aSessionBindings + right.a2aSessionBindings,
    outboundDeliveries: left.outboundDeliveries + right.outboundDeliveries,
    runtimeRequests: left.runtimeRequests + right.runtimeRequests,
  };
}

export function summarizeSubagentPurgeCounts(candidates: readonly SubagentPurgeCandidate[]): SubagentPurgeDbCounts {
  return candidates.reduce((sum, candidate) => sumCounts(sum, candidate.dbCounts), emptyCounts());
}

function candidateLabel(candidate: SubagentPurgeCandidate): string {
  return candidate.sessionIds.length > 0
    ? `subagent ${candidate.sessionIds.join(",")}`
    : `environment ${candidate.environment.id}`;
}

export class SubagentPurgeService {
  private readonly pool: PgPoolLike;
  private readonly environmentStore: ExecutionEnvironmentStopStore;
  private readonly manager: ExecutionEnvironmentManager | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessions = buildSessionTableNames();
  private readonly threads = buildThreadRuntimeTableNames();
  private readonly environments = buildExecutionEnvironmentTableNames();
  private readonly a2a = buildA2ATableNames();
  private readonly deliveries = buildOutboundDeliveryTableNames();
  private readonly requests = buildRuntimeRequestTableNames();

  constructor(options: SubagentPurgeServiceOptions) {
    this.pool = options.pool;
    this.environmentStore = options.environmentStore;
    this.manager = options.manager ?? null;
    this.env = options.env ?? process.env;
  }

  async plan(input: SubagentPurgeInput): Promise<SubagentPurgePlan> {
    if (!hasSelector(input.selector)) {
      throw new Error("Subagent purge requires at least one selector.");
    }

    const now = input.now ?? Date.now();
    const rows = await this.findCandidateRows(input.selector, now);
    if ((input.selector.sessionId || input.selector.environmentId) && rows.length === 0) {
      throw new Error("No disposable subagent environment matched the selector.");
    }

    const candidates: SubagentPurgeCandidate[] = [];
    const rowsByEnvironment = new Map<string, CandidateRow[]>();
    for (const row of rows) {
      const existing = rowsByEnvironment.get(row.environment_id);
      if (existing) {
        existing.push(row);
      } else {
        rowsByEnvironment.set(row.environment_id, [row]);
      }
    }

    for (const environmentRows of rowsByEnvironment.values()) {
      const row = environmentRows[0];
      if (!row) {
        continue;
      }
      const environment = parseEnvironmentRow(row);
      const sessionIds = uniqueTrimmedStrings(environmentRows.flatMap((candidateRow) => (
        candidateRow.session_id ? [candidateRow.session_id] : []
      )));
      const threadIds = (await Promise.all(sessionIds.map((sessionId) => this.listThreadIds(sessionId)))).flat();
      const filesystem = input.skipFiles
        ? {status: "skipped" as const, reason: "--skip-files was set"}
        : await this.planFilesystem({
          agentKey: row.environment_agent_key,
          environment,
        });
      const dbCounts = await this.countDbRows({
        sessionIds,
        environmentId: environment.id,
        threadIds,
      });
      const externalFileReferenceCount = input.execute
        ? await this.countExternalFileReferences({
          sessionIds,
          environmentId: environment.id,
          threadIds,
          environmentRootPath: filesystem.status === "safe" ? filesystem.rootPath : undefined,
        })
        : null;
      candidates.push({
        sessionId: sessionIds[0] ?? "",
        sessionIds,
        threadIds,
        ...(row.current_thread_id ? {currentThreadId: row.current_thread_id} : {}),
        agentKey: row.environment_agent_key,
        sessionCreatedAt: row.session_created_at ?? environment.createdAt,
        sessionUpdatedAt: row.session_updated_at ?? environment.updatedAt,
        environment,
        ...(readContainerName(environment.metadata) ? {containerName: readContainerName(environment.metadata)} : {}),
        filesystem,
        dbCounts,
        externalFileReferenceCount,
        ...(isActiveUnexpiredReady(environment, now) && !input.force
          ? {refusedReason: "active ready subagent environment is not expired; pass --force to purge it"}
          : {}),
      });
    }

    return {
      dryRun: !input.execute,
      now,
      candidates,
    };
  }

  async purge(input: SubagentPurgeInput): Promise<SubagentPurgePlan> {
    if (!input.execute) {
      return this.plan(input);
    }

    const plan = await this.plan(input);
    const refused = plan.candidates.find((candidate) => candidate.refusedReason);
    if (refused) {
      throw new Error(`Refusing to purge ${candidateLabel(refused)}: ${refused.refusedReason}.`);
    }

    if (!input.skipFiles) {
      const unsafe = plan.candidates.find((candidate) => candidate.filesystem.status !== "safe");
      if (unsafe) {
        throw new Error(`Refusing to purge ${candidateLabel(unsafe)}: filesystem root is ${unsafe.filesystem.status}.`);
      }
    }

    for (const candidate of plan.candidates) {
      if (shouldStopEnvironment(candidate.environment)) {
        await this.stopEnvironment(candidate.environment.id);
      }
    }

    await withTransaction(this.pool, async (client) => {
      for (const candidate of plan.candidates) {
        await this.deleteDbRows(client, candidate);
      }
    });

    if (!input.skipFiles) {
      for (const candidate of plan.candidates) {
        if (candidate.filesystem.status === "safe" && candidate.filesystem.rootPath) {
          await rm(candidate.filesystem.rootPath, {recursive: true, force: false});
        }
      }
    }

    return {
      ...plan,
      dryRun: false,
    };
  }

  private async stopEnvironment(environmentId: string): Promise<void> {
    if (!this.manager) {
      throw new Error("Purge needs an execution environment manager to stop active disposable subagents.");
    }
    await stopExecutionEnvironment({
      environmentId,
      manager: this.manager,
      store: this.environmentStore,
    });
  }

  private async findCandidateRows(selector: SubagentPurgeSelector, now: number): Promise<CandidateRow[]> {
    const values: unknown[] = [];
    const where = [
      "env.kind = 'disposable_container'",
    ];

    if (selector.agentKey) {
      values.push(requireTrimmed("agent key", selector.agentKey));
      where.push(`env.agent_key = $${values.length}`);
    }
    if (selector.sessionId) {
      values.push(requireTrimmed("session id", selector.sessionId));
      where.push(`session.id = $${values.length}`);
    }
    if (selector.environmentId) {
      values.push(requireTrimmed("environment id", selector.environmentId));
      where.push(`env.id = $${values.length}`);
    }
    if (selector.stopped) {
      where.push("env.state IN ('stopped', 'failed')");
    }
    if (selector.expired) {
      values.push(new Date(now));
      where.push(`env.expires_at IS NOT NULL AND env.expires_at <= $${values.length}`);
    }
    if (selector.olderThanMs !== undefined) {
      if (!Number.isInteger(selector.olderThanMs) || selector.olderThanMs < 1) {
        throw new Error("olderThanMs must be a positive integer.");
      }
      values.push(new Date(now - selector.olderThanMs));
      where.push(`env.updated_at <= $${values.length}`);
    }

    const result = await this.pool.query(`
      SELECT DISTINCT
        session.id AS session_id,
        session.agent_key AS session_agent_key,
        session.current_thread_id,
        session.created_at AS session_created_at,
        session.updated_at AS session_updated_at,
        env.id AS environment_id,
        env.agent_key AS environment_agent_key,
        env.kind,
        env.state,
        env.network_policy,
        env.runner_url,
        env.runner_cwd,
        env.root_path,
        env.created_by_session_id,
        env.created_for_session_id,
        env.expires_at,
        env.metadata,
        env.created_at AS environment_created_at,
        env.updated_at AS environment_updated_at
      FROM ${this.environments.executionEnvironments} AS env
      LEFT JOIN ${this.environments.sessionEnvironmentBindings} AS binding
        ON binding.environment_id = env.id
      LEFT JOIN ${this.sessions.sessions} AS session
        ON (session.id = env.created_for_session_id OR session.id = binding.session_id)
       AND session.kind = 'subagent'
      WHERE ${where.join("\n        AND ")}
      ORDER BY env.updated_at ASC, session.id ASC
    `, values);

    return result.rows.map((row) => parseCandidateRow(row as Record<string, unknown>));
  }

  private async listThreadIds(sessionId: string): Promise<readonly string[]> {
    const result = await this.pool.query(`
      SELECT id
      FROM ${this.threads.threads}
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC
    `, [sessionId]);
    return result.rows
      .map((row) => {
        const record = row as {id?: unknown};
        return typeof record.id === "string" ? record.id : "";
      })
      .filter(Boolean);
  }

  private async planFilesystem(input: {
    agentKey: string;
    environment: ExecutionEnvironmentRecord;
  }): Promise<SubagentPurgeFilesystemPlan> {
    const filesystem = readExecutionEnvironmentFilesystemMetadata(input.environment.metadata);
    if (!filesystem) {
      return {
        status: "missing_metadata",
        reason: "execution environment metadata has no filesystem root",
      };
    }

    const rootPaths = [
      filesystem.root.corePath,
      filesystem.root.hostPath,
      filesystem.root.managerPath,
    ].filter((entry): entry is string => Boolean(trimToUndefined(entry)));
    let unsafe: SubagentPurgeFilesystemPlan | undefined;
    for (const rootPath of rootPaths) {
      if (!await pathExists(rootPath)) {
        continue;
      }
      const safe = await resolveSafeEnvironmentRoot({
        env: this.env,
        agentKey: input.agentKey,
        rootPath,
        envDir: filesystem.envDir,
      });
      if (!safe.ok) {
        unsafe = {
          status: "unsafe",
          rootPath,
          envDir: filesystem.envDir,
          reason: safe.reason,
        };
        continue;
      }

      return {
        status: "safe",
        rootPath: safe.rootPath,
        envDir: filesystem.envDir,
        bytes: await directoryBytes(safe.rootPath),
      };
    }

    if (unsafe) {
      return unsafe;
    }

    const firstRootPath = rootPaths[0];
    if (!firstRootPath) {
      return {
        status: "missing",
        envDir: filesystem.envDir,
        reason: "filesystem metadata has no root path",
      };
    }

    return {
      status: "missing",
      rootPath: firstRootPath,
      envDir: filesystem.envDir,
      reason: "filesystem root does not exist",
    };
  }

  private async countDbRows(input: {
    sessionIds: readonly string[];
    environmentId: string;
    threadIds: readonly string[];
  }): Promise<SubagentPurgeDbCounts> {
    const counts = emptyCounts();
    const sessionValues: unknown[] = [];
    const sessionClause = buildTextInClause("id", input.sessionIds, sessionValues);
    counts.sessions = await this.countSimple(
      `${this.sessions.sessions} WHERE ${sessionClause} AND kind = 'subagent'`,
      sessionValues,
    );
    const heartbeatValues: unknown[] = [];
    const heartbeatClause = buildTextInClause("session_id", input.sessionIds, heartbeatValues);
    counts.sessionHeartbeats = await this.countSimple(
      `${this.sessions.sessionHeartbeats} WHERE ${heartbeatClause}`,
      heartbeatValues,
    );
    counts.executionEnvironments = await this.countSimple(`${this.environments.executionEnvironments} WHERE id = $1`, [input.environmentId]);
    const bindingValues: unknown[] = [input.environmentId];
    const bindingSessionClause = buildTextInClause("session_id", input.sessionIds, bindingValues);
    counts.sessionEnvironmentBindings = await this.countSimple(
      `${this.environments.sessionEnvironmentBindings} WHERE environment_id = $1 OR ${bindingSessionClause}`,
      bindingValues,
    );
    const a2aValues: unknown[] = [];
    const a2aSenderClause = buildTextInClause("sender_session_id", input.sessionIds, a2aValues);
    const a2aRecipientClause = buildTextInClause("recipient_session_id", input.sessionIds, a2aValues);
    counts.a2aSessionBindings = await this.countSimple(
      `${this.a2a.a2aSessionBindings} WHERE ${a2aSenderClause} OR ${a2aRecipientClause}`,
      a2aValues,
    );

    const threadValues: unknown[] = [];
    const threadClause = buildTextInClause("thread_id", input.threadIds, threadValues);
    counts.threads = input.threadIds.length;
    counts.messages = await this.countSimple(`${this.threads.messages} WHERE ${threadClause}`, threadValues);
    counts.inputs = await this.countSimple(`${this.threads.inputs} WHERE ${threadClause}`, threadValues);
    counts.runs = await this.countSimple(`${this.threads.runs} WHERE ${threadClause}`, threadValues);
    counts.toolJobs = await this.countSimple(`${this.threads.toolJobs} WHERE ${threadClause}`, threadValues);
    counts.bashJobs = await this.countSimple(`${this.threads.bashJobs} WHERE ${threadClause}`, threadValues);
    counts.outboundDeliveries = await this.countOutboundDeliveries(input);
    counts.runtimeRequests = await this.countRuntimeRequests(input);
    return counts;
  }

  private async countSimple(fromAndWhere: string, values: unknown[]): Promise<number> {
    const result = await this.pool.query(`SELECT COUNT(*)::INTEGER AS count FROM ${fromAndWhere}`, values);
    return requireNonNegativeInteger(
      (result.rows[0] as {count?: unknown} | undefined)?.count ?? 0,
      "Subagent purge row count",
    );
  }

  private async countOutboundDeliveries(input: {
    sessionIds: readonly string[];
    environmentId: string;
    threadIds: readonly string[];
  }): Promise<number> {
    const values: unknown[] = [];
    const subagentClause = buildOutboundDeliverySubagentClause(input, values);
    return this.countSimple(
      `${this.deliveries.outboundDeliveries} WHERE ${subagentClause}`,
      values,
    );
  }

  private async countRuntimeRequests(input: {
    sessionIds: readonly string[];
    environmentId: string;
    threadIds: readonly string[];
  }): Promise<number> {
    const values: unknown[] = [];
    const subagentClause = buildRuntimeRequestSubagentClause(input, values);
    return this.countSimple(
      `${this.requests.runtimeRequests} WHERE ${subagentClause}`,
      values,
    );
  }

  private async countExternalFileReferences(input: {
    sessionIds: readonly string[];
    environmentId: string;
    threadIds: readonly string[];
    environmentRootPath: string | undefined;
  }): Promise<number> {
    const paths = new Set<string>();
    const needles = [...input.sessionIds, input.environmentId, ...input.threadIds];
    await this.collectThreadJsonPaths(input, needles, paths);
    await this.collectOutboundDeliveryPaths(input, needles, paths);
    await this.collectRuntimeRequestPaths(needles, paths);
    return countExternalPaths(paths, input.environmentRootPath);
  }

  private async collectThreadJsonPaths(
    input: {sessionIds: readonly string[]; threadIds: readonly string[]},
    needles: readonly string[],
    paths: Set<string>,
  ): Promise<void> {
    const threadValues: unknown[] = [];
    const threadClause = buildTextInClause("thread_id", input.threadIds, threadValues);
    for (const table of [this.threads.messages, this.threads.inputs]) {
      const values = [...threadValues];
      const channelClause = buildTextInClause("channel_id", input.sessionIds, values);
      const metadataClause = buildLikeClause("metadata", needles, values);
      const messageClause = buildLikeClause("message", needles, values);
      const result = await this.pool.query(`
        SELECT message, metadata
        FROM ${table}
        WHERE ${threadClause}
           OR ${channelClause}
           OR ${metadataClause}
           OR ${messageClause}
      `, values);
      for (const row of result.rows as Array<{message?: unknown; metadata?: unknown}>) {
        collectAbsolutePathReferences(row.message, paths);
        collectAbsolutePathReferences(row.metadata, paths);
      }
    }

    const toolValues = [...threadValues];
    const toolResultClause = buildLikeClause("result", needles, toolValues);
    const toolProgressClause = buildLikeClause("progress", needles, toolValues);
    const toolJobs = await this.pool.query(`
      SELECT result, progress
      FROM ${this.threads.toolJobs}
      WHERE ${threadClause}
         OR ${toolResultClause}
         OR ${toolProgressClause}
    `, toolValues);
    for (const row of toolJobs.rows as Array<{result?: unknown; progress?: unknown}>) {
      collectAbsolutePathReferences(row.result, paths);
      collectAbsolutePathReferences(row.progress, paths);
    }

    const bashJobs = await this.pool.query(`
      SELECT stdout_path, stderr_path
      FROM ${this.threads.bashJobs}
      WHERE ${threadClause}
    `, threadValues);
    for (const row of bashJobs.rows as Array<{stdout_path?: unknown; stderr_path?: unknown}>) {
      collectAbsolutePathReferences(row.stdout_path, paths);
      collectAbsolutePathReferences(row.stderr_path, paths);
    }
  }

  private async collectOutboundDeliveryPaths(
    input: {sessionIds: readonly string[]; environmentId: string; threadIds: readonly string[]},
    needles: readonly string[],
    paths: Set<string>,
  ): Promise<void> {
    const values: unknown[] = [];
    const threadClause = buildTextInClause("thread_id", input.threadIds, values);
    const sessionClause = buildTextInClause("external_conversation_id", input.sessionIds, values);
    const metadataClause = buildLikeClause("metadata", needles, values);
    const itemsClause = buildLikeClause("items", needles, values);
    const result = await this.pool.query(`
      SELECT items, metadata, sent_items
      FROM ${this.deliveries.outboundDeliveries}
      WHERE ${threadClause}
         OR ${sessionClause}
         OR ${metadataClause}
         OR ${itemsClause}
    `, values);
    for (const row of result.rows as Array<{items?: unknown; metadata?: unknown; sent_items?: unknown}>) {
      collectAbsolutePathReferences(row.items, paths);
      collectAbsolutePathReferences(row.metadata, paths);
      collectAbsolutePathReferences(row.sent_items, paths);
    }
  }

  private async collectRuntimeRequestPaths(needles: readonly string[], paths: Set<string>): Promise<void> {
    const values: unknown[] = [];
    const payloadClause = buildLikeClause("payload", needles, values);
    const resultClause = buildLikeClause("result", needles, values);
    const result = await this.pool.query(`
      SELECT payload, result
      FROM ${this.requests.runtimeRequests}
      WHERE ${payloadClause}
         OR ${resultClause}
    `, values);
    for (const row of result.rows as Array<{payload?: unknown; result?: unknown}>) {
      collectAbsolutePathReferences(row.payload, paths);
      collectAbsolutePathReferences(row.result, paths);
    }
  }

  private async deleteDbRows(client: PgClientLike, candidate: SubagentPurgeCandidate): Promise<void> {
    await this.deleteOutboundDeliveries(client, candidate);
    await this.deleteRuntimeRequests(client, candidate);
    await client.query(`DELETE FROM ${this.environments.executionEnvironments} WHERE id = $1`, [
      candidate.environment.id,
    ]);
    if (candidate.sessionIds.length > 0) {
      const values: unknown[] = [];
      const sessionClause = buildTextInClause("id", candidate.sessionIds, values);
      await client.query(`DELETE FROM ${this.sessions.sessions} WHERE ${sessionClause} AND kind = 'subagent'`, values);
    }
  }

  private async deleteOutboundDeliveries(client: PgClientLike, candidate: SubagentPurgeCandidate): Promise<void> {
    const values: unknown[] = [];
    const subagentClause = buildOutboundDeliverySubagentClause(candidate, values);
    await client.query(`
      DELETE FROM ${this.deliveries.outboundDeliveries}
      WHERE ${subagentClause}
    `, values);
  }

  private async deleteRuntimeRequests(client: PgClientLike, candidate: SubagentPurgeCandidate): Promise<void> {
    const values: unknown[] = [];
    const subagentClause = buildRuntimeRequestSubagentClause({
      sessionIds: candidate.sessionIds,
      environmentId: candidate.environment.id,
      threadIds: candidate.threadIds,
    }, values);
    await client.query(`
      DELETE FROM ${this.requests.runtimeRequests}
      WHERE ${subagentClause}
    `, values);
  }
}
