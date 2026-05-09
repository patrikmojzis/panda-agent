import {lstat, readdir, realpath, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {PoolClient} from "pg";

import {buildA2ATableNames} from "../../domain/a2a/postgres-shared.js";
import {buildOutboundDeliveryTableNames} from "../../domain/channels/deliveries/postgres-shared.js";
import {
    type ExecutionEnvironmentManager,
    type ExecutionEnvironmentRecord,
    type ExecutionEnvironmentState,
    type ExecutionEnvironmentStore,
    readExecutionEnvironmentFilesystemMetadata,
} from "../../domain/execution-environments/index.js";
import {buildExecutionEnvironmentTableNames} from "../../domain/execution-environments/postgres-shared.js";
import {buildSessionTableNames} from "../../domain/sessions/postgres-shared.js";
import {buildRuntimeRequestTableNames} from "../../domain/threads/requests/postgres-shared.js";
import {buildThreadRuntimeTableNames, toMillis,} from "../../domain/threads/runtime/postgres-shared.js";
import {type PgPoolLike, withTransaction} from "../../domain/threads/runtime/postgres-db.js";
import type {JsonValue} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {trimToUndefined} from "../../lib/strings.js";
import {resolveDataDir} from "./data-dir.js";
import {ExecutionEnvironmentLifecycleService} from "./execution-environment-service.js";

export interface WorkerPurgeSelector {
  agentKey?: string;
  sessionId?: string;
  environmentId?: string;
  stopped?: boolean;
  expired?: boolean;
  olderThanMs?: number;
}

export interface WorkerPurgeInput {
  selector: WorkerPurgeSelector;
  execute?: boolean;
  force?: boolean;
  skipFiles?: boolean;
  now?: number;
}

export interface WorkerPurgeDbCounts {
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

export type WorkerPurgeFilesystemStatus =
  | "safe"
  | "missing"
  | "missing_metadata"
  | "skipped"
  | "unsafe";

export interface WorkerPurgeFilesystemPlan {
  status: WorkerPurgeFilesystemStatus;
  rootPath?: string;
  envDir?: string;
  bytes?: number;
  reason?: string;
}

export interface WorkerPurgeCandidate {
  sessionId: string;
  threadIds: readonly string[];
  currentThreadId: string;
  agentKey: string;
  sessionCreatedAt: number;
  sessionUpdatedAt: number;
  environment: ExecutionEnvironmentRecord;
  containerName?: string;
  filesystem: WorkerPurgeFilesystemPlan;
  dbCounts: WorkerPurgeDbCounts;
  externalFileReferenceCount: number;
  refusedReason?: string;
}

export interface WorkerPurgePlan {
  dryRun: boolean;
  now: number;
  candidates: readonly WorkerPurgeCandidate[];
}

export interface WorkerPurgeServiceOptions {
  pool: PgPoolLike;
  environmentStore: ExecutionEnvironmentStore;
  manager?: ExecutionEnvironmentManager | null;
  env?: NodeJS.ProcessEnv;
}

interface CandidateRow {
  session_id: string;
  agent_key: string;
  current_thread_id: string;
  session_created_at: unknown;
  session_updated_at: unknown;
  environment_id: string;
  environment_agent_key: string;
  kind: string;
  state: string;
  runner_url: string | null;
  runner_cwd: string | null;
  root_path: string | null;
  created_by_session_id: string | null;
  created_for_session_id: string | null;
  expires_at: unknown;
  metadata: JsonValue | null;
  environment_created_at: unknown;
  environment_updated_at: unknown;
}

const STOPPED_PURGE_STATES = new Set<ExecutionEnvironmentState>(["stopped", "failed"]);
const PATH_REFERENCE_KEYS = new Set(["localPath", "path", "stdoutPath", "stderrPath"]);

function requireTrimmed(field: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${field} must not be empty.`);
  }
  return trimmed;
}

function hasSelector(selector: WorkerPurgeSelector): boolean {
  return Boolean(
    trimToUndefined(selector.agentKey)
    || trimToUndefined(selector.sessionId)
    || trimToUndefined(selector.environmentId)
    || selector.stopped
    || selector.expired
    || selector.olderThanMs !== undefined,
  );
}

function parseEnvironmentRow(row: CandidateRow): ExecutionEnvironmentRecord {
  return {
    id: row.environment_id,
    agentKey: row.environment_agent_key,
    kind: row.kind as ExecutionEnvironmentRecord["kind"],
    state: row.state as ExecutionEnvironmentState,
    ...(row.runner_url ? {runnerUrl: row.runner_url} : {}),
    ...(row.runner_cwd ? {runnerCwd: row.runner_cwd} : {}),
    ...(row.root_path ? {rootPath: row.root_path} : {}),
    ...(row.created_by_session_id ? {createdBySessionId: row.created_by_session_id} : {}),
    ...(row.created_for_session_id ? {createdForSessionId: row.created_for_session_id} : {}),
    ...(row.expires_at ? {expiresAt: toMillis(row.expires_at)} : {}),
    ...(row.metadata === null ? {} : {metadata: row.metadata}),
    createdAt: toMillis(row.environment_created_at),
    updatedAt: toMillis(row.environment_updated_at),
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

function buildThreadIdClause(column: string, threadIds: readonly string[], values: unknown[]): string {
  if (threadIds.length === 0) {
    return "FALSE";
  }
  const placeholders = threadIds.map((threadId) => {
    values.push(threadId);
    return `$${values.length}`;
  });
  return `${column} IN (${placeholders.join(", ")})`;
}

function emptyCounts(): WorkerPurgeDbCounts {
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

function sumCounts(left: WorkerPurgeDbCounts, right: WorkerPurgeDbCounts): WorkerPurgeDbCounts {
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

export function summarizeWorkerPurgeCounts(candidates: readonly WorkerPurgeCandidate[]): WorkerPurgeDbCounts {
  return candidates.reduce((sum, candidate) => sumCounts(sum, candidate.dbCounts), emptyCounts());
}

export class WorkerPurgeService {
  private readonly pool: PgPoolLike;
  private readonly environmentStore: ExecutionEnvironmentStore;
  private readonly manager: ExecutionEnvironmentManager | null;
  private readonly env: NodeJS.ProcessEnv;
  private readonly sessions = buildSessionTableNames();
  private readonly threads = buildThreadRuntimeTableNames();
  private readonly environments = buildExecutionEnvironmentTableNames();
  private readonly a2a = buildA2ATableNames();
  private readonly deliveries = buildOutboundDeliveryTableNames();
  private readonly requests = buildRuntimeRequestTableNames();

  constructor(options: WorkerPurgeServiceOptions) {
    this.pool = options.pool;
    this.environmentStore = options.environmentStore;
    this.manager = options.manager ?? null;
    this.env = options.env ?? process.env;
  }

  async plan(input: WorkerPurgeInput): Promise<WorkerPurgePlan> {
    if (!hasSelector(input.selector)) {
      throw new Error("Worker purge requires at least one selector.");
    }

    const now = input.now ?? Date.now();
    const rows = await this.findCandidateRows(input.selector, now);
    if ((input.selector.sessionId || input.selector.environmentId) && rows.length === 0) {
      throw new Error("No worker-owned disposable environment matched the selector.");
    }

    const candidates: WorkerPurgeCandidate[] = [];
    for (const row of rows) {
      const environment = parseEnvironmentRow(row);
      const threadIds = await this.listThreadIds(row.session_id);
      const filesystem = input.skipFiles
        ? {status: "skipped" as const, reason: "--skip-files was set"}
        : await this.planFilesystem({
          agentKey: row.agent_key,
          environment,
        });
      candidates.push({
        sessionId: row.session_id,
        threadIds,
        currentThreadId: row.current_thread_id,
        agentKey: row.agent_key,
        sessionCreatedAt: toMillis(row.session_created_at),
        sessionUpdatedAt: toMillis(row.session_updated_at),
        environment,
        ...(readContainerName(environment.metadata) ? {containerName: readContainerName(environment.metadata)} : {}),
        filesystem,
        dbCounts: await this.countDbRows({
          sessionId: row.session_id,
          environmentId: environment.id,
          threadIds,
        }),
        externalFileReferenceCount: await this.countExternalFileReferences({
          sessionId: row.session_id,
          environmentId: environment.id,
          threadIds,
          environmentRootPath: filesystem.status === "safe" ? filesystem.rootPath : undefined,
        }),
        ...(isActiveUnexpiredReady(environment, now) && !input.force
          ? {refusedReason: "active ready worker is not expired; pass --force to purge it"}
          : {}),
      });
    }

    return {
      dryRun: !input.execute,
      now,
      candidates,
    };
  }

  async purge(input: WorkerPurgeInput): Promise<WorkerPurgePlan> {
    if (!input.execute) {
      return this.plan(input);
    }

    const plan = await this.plan(input);
    const refused = plan.candidates.find((candidate) => candidate.refusedReason);
    if (refused) {
      throw new Error(`Refusing to purge worker ${refused.sessionId}: ${refused.refusedReason}.`);
    }

    if (!input.skipFiles) {
      const unsafe = plan.candidates.find((candidate) => candidate.filesystem.status !== "safe");
      if (unsafe) {
        throw new Error(`Refusing to purge worker ${unsafe.sessionId}: filesystem root is ${unsafe.filesystem.status}.`);
      }
    }

    for (const candidate of plan.candidates) {
      if (shouldStopEnvironment(candidate.environment)) {
        await this.stopEnvironment(candidate.environment.id);
      }
    }

    if (!input.skipFiles) {
      for (const candidate of plan.candidates) {
        if (candidate.filesystem.status === "safe" && candidate.filesystem.rootPath) {
          await rm(candidate.filesystem.rootPath, {recursive: true, force: false});
        }
      }
    }

    await withTransaction(this.pool, async (client) => {
      for (const candidate of plan.candidates) {
        await this.deleteDbRows(client, candidate);
      }
    });

    return {
      ...plan,
      dryRun: false,
    };
  }

  private async stopEnvironment(environmentId: string): Promise<void> {
    if (!this.manager) {
      throw new Error("Purge needs an execution environment manager to stop active disposable workers.");
    }
    const lifecycle = new ExecutionEnvironmentLifecycleService({
      store: this.environmentStore,
      manager: this.manager,
    });
    await lifecycle.stopEnvironment(environmentId);
  }

  private async findCandidateRows(selector: WorkerPurgeSelector, now: number): Promise<CandidateRow[]> {
    const values: unknown[] = [];
    const where = [
      "env.kind = 'disposable_container'",
      "session.kind = 'worker'",
    ];

    if (selector.agentKey) {
      values.push(requireTrimmed("agent key", selector.agentKey));
      where.push(`session.agent_key = $${values.length}`);
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
        session.agent_key,
        session.current_thread_id,
        session.created_at AS session_created_at,
        session.updated_at AS session_updated_at,
        env.id AS environment_id,
        env.agent_key AS environment_agent_key,
        env.kind,
        env.state,
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
      INNER JOIN ${this.sessions.sessions} AS session
        ON session.id = COALESCE(env.created_for_session_id, binding.session_id)
      WHERE ${where.join("\n        AND ")}
      ORDER BY env.updated_at ASC, session.id ASC
    `, values);

    return result.rows as CandidateRow[];
  }

  private async listThreadIds(sessionId: string): Promise<readonly string[]> {
    const result = await this.pool.query(`
      SELECT id
      FROM ${this.threads.threads}
      WHERE session_id = $1
      ORDER BY created_at ASC, id ASC
    `, [sessionId]);
    return result.rows
      .map((row) => typeof row.id === "string" ? row.id : "")
      .filter(Boolean);
  }

  private async planFilesystem(input: {
    agentKey: string;
    environment: ExecutionEnvironmentRecord;
  }): Promise<WorkerPurgeFilesystemPlan> {
    const filesystem = readExecutionEnvironmentFilesystemMetadata(input.environment.metadata);
    if (!filesystem) {
      return {
        status: "missing_metadata",
        reason: "execution environment metadata has no filesystem root",
      };
    }

    const rootPath = filesystem.root.hostPath ?? filesystem.root.corePath;
    if (!rootPath || !await pathExists(rootPath)) {
      return {
        status: "missing",
        rootPath,
        envDir: filesystem.envDir,
        reason: "filesystem root does not exist",
      };
    }

    const safe = await resolveSafeEnvironmentRoot({
      env: this.env,
      agentKey: input.agentKey,
      rootPath,
      envDir: filesystem.envDir,
    });
    if (!safe.ok) {
      return {
        status: "unsafe",
        rootPath,
        envDir: filesystem.envDir,
        reason: safe.reason,
      };
    }

    return {
      status: "safe",
      rootPath: safe.rootPath,
      envDir: filesystem.envDir,
      bytes: await directoryBytes(safe.rootPath),
    };
  }

  private async countDbRows(input: {
    sessionId: string;
    environmentId: string;
    threadIds: readonly string[];
  }): Promise<WorkerPurgeDbCounts> {
    const counts = emptyCounts();
    counts.sessions = await this.countSimple(`${this.sessions.sessions} WHERE id = $1 AND kind = 'worker'`, [input.sessionId]);
    counts.sessionHeartbeats = await this.countSimple(`${this.sessions.sessionHeartbeats} WHERE session_id = $1`, [input.sessionId]);
    counts.executionEnvironments = await this.countSimple(`${this.environments.executionEnvironments} WHERE id = $1`, [input.environmentId]);
    counts.sessionEnvironmentBindings = await this.countSimple(
      `${this.environments.sessionEnvironmentBindings} WHERE session_id = $1 OR environment_id = $2`,
      [input.sessionId, input.environmentId],
    );
    counts.a2aSessionBindings = await this.countSimple(
      `${this.a2a.a2aSessionBindings} WHERE sender_session_id = $1 OR recipient_session_id = $1`,
      [input.sessionId],
    );

    const threadValues: unknown[] = [];
    const threadClause = buildThreadIdClause("thread_id", input.threadIds, threadValues);
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
    return Number((result.rows[0] as {count?: unknown} | undefined)?.count ?? 0);
  }

  private async countOutboundDeliveries(input: {
    sessionId: string;
    environmentId: string;
    threadIds: readonly string[];
  }): Promise<number> {
    const values: unknown[] = [];
    const threadClause = buildThreadIdClause("thread_id", input.threadIds, values);
    values.push(input.sessionId);
    const sessionPlaceholder = `$${values.length}`;
    const metadataClause = buildLikeClause("metadata", [input.sessionId, input.environmentId], values);
    const itemsClause = buildLikeClause("items", [input.sessionId, input.environmentId], values);
    return this.countSimple(
      `${this.deliveries.outboundDeliveries}
       WHERE ${threadClause}
          OR external_conversation_id = ${sessionPlaceholder}
          OR ${metadataClause}
          OR ${itemsClause}`,
      values,
    );
  }

  private async countRuntimeRequests(input: {
    sessionId: string;
    environmentId: string;
    threadIds: readonly string[];
  }): Promise<number> {
    const values: unknown[] = [];
    const needles = [input.sessionId, input.environmentId, ...input.threadIds];
    const payloadClause = buildLikeClause("payload", needles, values);
    const resultClause = buildLikeClause("result", needles, values);
    return this.countSimple(
      `${this.requests.runtimeRequests} WHERE ${payloadClause} OR ${resultClause}`,
      values,
    );
  }

  private async countExternalFileReferences(input: {
    sessionId: string;
    environmentId: string;
    threadIds: readonly string[];
    environmentRootPath: string | undefined;
  }): Promise<number> {
    const paths = new Set<string>();
    const needles = [input.sessionId, input.environmentId, ...input.threadIds];
    await this.collectThreadJsonPaths(input, needles, paths);
    await this.collectOutboundDeliveryPaths(input, needles, paths);
    await this.collectRuntimeRequestPaths(needles, paths);
    return countExternalPaths(paths, input.environmentRootPath);
  }

  private async collectThreadJsonPaths(
    input: {sessionId: string; threadIds: readonly string[]},
    needles: readonly string[],
    paths: Set<string>,
  ): Promise<void> {
    const threadValues: unknown[] = [];
    const threadClause = buildThreadIdClause("thread_id", input.threadIds, threadValues);
    for (const table of [this.threads.messages, this.threads.inputs]) {
      const values = [...threadValues];
      values.push(input.sessionId);
      const channelPlaceholder = `$${values.length}`;
      const metadataClause = buildLikeClause("metadata", needles, values);
      const messageClause = buildLikeClause("message", needles, values);
      const result = await this.pool.query(`
        SELECT message, metadata
        FROM ${table}
        WHERE ${threadClause}
           OR channel_id = ${channelPlaceholder}
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
    input: {sessionId: string; environmentId: string; threadIds: readonly string[]},
    needles: readonly string[],
    paths: Set<string>,
  ): Promise<void> {
    const values: unknown[] = [];
    const threadClause = buildThreadIdClause("thread_id", input.threadIds, values);
    values.push(input.sessionId);
    const sessionPlaceholder = `$${values.length}`;
    const metadataClause = buildLikeClause("metadata", needles, values);
    const itemsClause = buildLikeClause("items", needles, values);
    const result = await this.pool.query(`
      SELECT items, metadata, sent_items
      FROM ${this.deliveries.outboundDeliveries}
      WHERE ${threadClause}
         OR external_conversation_id = ${sessionPlaceholder}
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

  private async deleteDbRows(client: PoolClient, candidate: WorkerPurgeCandidate): Promise<void> {
    await this.deleteOutboundDeliveries(client, candidate);
    await this.deleteRuntimeRequests(client, candidate);
    await client.query(`DELETE FROM ${this.environments.executionEnvironments} WHERE id = $1`, [
      candidate.environment.id,
    ]);
    await client.query(`DELETE FROM ${this.sessions.sessions} WHERE id = $1 AND kind = 'worker'`, [
      candidate.sessionId,
    ]);
  }

  private async deleteOutboundDeliveries(client: PoolClient, candidate: WorkerPurgeCandidate): Promise<void> {
    const values: unknown[] = [];
    const threadClause = buildThreadIdClause("thread_id", candidate.threadIds, values);
    values.push(candidate.sessionId);
    const sessionPlaceholder = `$${values.length}`;
    const metadataClause = buildLikeClause("metadata", [candidate.sessionId, candidate.environment.id], values);
    const itemsClause = buildLikeClause("items", [candidate.sessionId, candidate.environment.id], values);
    await client.query(`
      DELETE FROM ${this.deliveries.outboundDeliveries}
      WHERE ${threadClause}
         OR external_conversation_id = ${sessionPlaceholder}
         OR ${metadataClause}
         OR ${itemsClause}
    `, values);
  }

  private async deleteRuntimeRequests(client: PoolClient, candidate: WorkerPurgeCandidate): Promise<void> {
    const values: unknown[] = [];
    const needles = [candidate.sessionId, candidate.environment.id, ...candidate.threadIds];
    const payloadClause = buildLikeClause("payload", needles, values);
    const resultClause = buildLikeClause("result", needles, values);
    await client.query(`
      DELETE FROM ${this.requests.runtimeRequests}
      WHERE ${payloadClause}
         OR ${resultClause}
    `, values);
  }
}
