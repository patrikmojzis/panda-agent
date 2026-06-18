import {toJson} from "../../../lib/postgres-values.js";
import {randomUUID} from "node:crypto";

import {
    buildThreadRuntimeTableNames, type ThreadRuntimeTableNames} from "./postgres-shared.js";
import {buildThreadRuntimeNotificationChannel, type ThreadRuntimeNotification} from "./postgres-notifications.js";
import {ensurePostgresThreadRuntimeSchema} from "./postgres-schema.js";
import {
    parseInputRow,
    parseMessageRow,
    parseRunRow,
    parseRunningToolJobLossRow,
    parseThreadRow,
    parseToolJobRow,
} from "./postgres-rows.js";
import {
    applyPendingThreadInputs,
    discardPendingThreadInputs,
    enqueueThreadInput,
    promoteQueuedThreadInputs,
} from "./postgres-inputs.js";
import type {PgPoolLike, PgQueryResult, PgQueryable} from "../../../lib/postgres-query.js";
import type {ThreadEnqueueResult, ThreadInputApplyScope, ThreadRuntimeStore} from "./store.js";
import type {DurableShellSession, ThreadShellStateKey, ThreadShellStateRecord, ThreadShellStateStore} from "./shell-state-store.js";
import {
    type CreateThreadInput,
    type CreateThreadToolJobInput,
    missingThreadError,
    type ThreadInputDeliveryMode,
    type ThreadInputPayload,
    type ThreadInputRecord,
    type ThreadMessageRecord,
    type ThreadRecord,
    type ThreadRunRecord,
    type ThreadRuntimeMessagePayload,
    type ThreadSummaryRecord,
    type ThreadToolJobRecord,
    type ThreadToolJobUpdate,
    type ThreadUpdate,
} from "./types.js";
import {buildSessionTableNames, type SessionTableNames} from "../../sessions/postgres-shared.js";
import {
  createThreadRuntimeJsonbPersistenceError,
  serializeThreadRuntimeJsonb,
} from "./postgres-jsonb-safety.js";

interface PostgresThreadRuntimeStoreOptions {
  pool: PgPoolLike;
}

function parseThreadSummaryCount(row: Record<string, unknown>, column: string): {
  threadId: string;
  count: number;
} {
  if (typeof row.thread_id !== "string" || !row.thread_id.trim()) {
    throw new Error("Thread runtime summary count thread id must not be empty.");
  }

  const value = row[column] ?? 0;
  const count = typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : typeof value === "string" && /^[0-9]+$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Thread runtime summary ${column} must be a non-negative safe integer.`);
  }

  return {
    threadId: row.thread_id,
    count,
  };
}

export class PostgresThreadRuntimeStore implements ThreadRuntimeStore, ThreadShellStateStore {
  private readonly pool: PgPoolLike;
  private readonly tables: ThreadRuntimeTableNames;
  private readonly sessionTables: SessionTableNames;
  private readonly notificationChannel: string;

  constructor(options: PostgresThreadRuntimeStoreOptions) {
    this.pool = options.pool;
    this.tables = buildThreadRuntimeTableNames();
    this.sessionTables = buildSessionTableNames();
    this.notificationChannel = buildThreadRuntimeNotificationChannel();
  }

  private async notifyThreadChanged(threadId: string, queryable: PgQueryable = this.pool): Promise<void> {
    await queryable.query("SELECT pg_notify($1, $2)", [
      this.notificationChannel,
      JSON.stringify({ threadId } satisfies ThreadRuntimeNotification),
    ]);
  }

  private async touchThread(threadId: string, queryable: PgQueryable = this.pool): Promise<void> {
    await queryable.query(
      `UPDATE ${this.tables.threads} SET updated_at = NOW() WHERE id = $1`,
      [threadId],
    );
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresThreadRuntimeSchema(this.pool);
  }

  async createThreadRecord(input: CreateThreadInput, queryable: PgQueryable = this.pool): Promise<ThreadRecord> {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) {
      throw new Error(`Thread ${input.id} is missing sessionId.`);
    }
    const result = await queryable.query(`
      INSERT INTO ${this.tables.threads} (
        id,
        session_id,
        runtime_state
      ) VALUES (
        $1,
        $2,
        $3::jsonb
      )
      ON CONFLICT (id) DO UPDATE
      SET runtime_state = EXCLUDED.runtime_state,
          updated_at = NOW()
      WHERE ${this.tables.threads}.session_id = EXCLUDED.session_id
        AND ${this.tables.threads}.runtime_state IS NULL
      RETURNING *
    `, [
      input.id,
      sessionId,
      toJson(input.runtimeState),
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Thread ${input.id} already exists and cannot be recreated.`);
    }

    const record = parseThreadRow(row as Record<string, unknown>);
    await this.notifyThreadChanged(record.id, queryable);
    return record;
  }

  async createThread(input: CreateThreadInput): Promise<ThreadRecord> {
    return this.createThreadRecord(input);
  }

  async getThread(threadId: string): Promise<ThreadRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.threads} WHERE id = $1`,
      [threadId],
    );

    const row = result.rows[0];
    if (!row) {
      throw missingThreadError(threadId);
    }

    return parseThreadRow(row as Record<string, unknown>);
  }

  private parseShellStateRow(row: Record<string, unknown>): ThreadShellStateRecord {
    const sessionId = typeof row.session_id === "string" ? row.session_id : "";
    const threadId = typeof row.thread_id === "string" ? row.thread_id : "";
    const executionEnvironmentId = typeof row.execution_environment_id === "string" ? row.execution_environment_id : "";
    const cwd = typeof row.cwd === "string" && row.cwd.trim() ? row.cwd : null;
    const env = row.env && typeof row.env === "object" && !Array.isArray(row.env)
      ? Object.fromEntries(Object.entries(row.env as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {};
    if (!sessionId || !threadId || !executionEnvironmentId || !cwd) {
      throw new Error("Invalid shell state row.");
    }

    return {
      sessionId,
      threadId,
      executionEnvironmentId,
      shellSession: {cwd, env},
      updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : Date.parse(String(row.updated_at)),
    };
  }

  async listShellSessions(input: Pick<ThreadShellStateKey, "sessionId">): Promise<Record<string, DurableShellSession>> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.shellStates}
      WHERE session_id = $1
      ORDER BY execution_environment_id ASC, updated_at ASC, thread_id ASC
    `, [input.sessionId]);

    const latestByEnvironment = new Map<string, ThreadShellStateRecord>();
    for (const row of result.rows) {
      const record = this.parseShellStateRow(row as Record<string, unknown>);
      const existing = latestByEnvironment.get(record.executionEnvironmentId);
      if (!existing || record.updatedAt >= existing.updatedAt) {
        latestByEnvironment.set(record.executionEnvironmentId, record);
      }
    }

    return Object.fromEntries([...latestByEnvironment.values()].map((record) => {
      return [record.executionEnvironmentId, record.shellSession];
    }));
  }

  async upsertShellSession(input: ThreadShellStateKey & {shellSession: DurableShellSession}): Promise<ThreadShellStateRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.shellStates} (
        session_id,
        thread_id,
        execution_environment_id,
        cwd,
        env
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb
      )
      ON CONFLICT (session_id, thread_id, execution_environment_id) DO UPDATE
      SET cwd = EXCLUDED.cwd,
          env = EXCLUDED.env,
          updated_at = NOW()
      RETURNING *
    `, [
      input.sessionId,
      input.threadId,
      input.executionEnvironmentId,
      input.shellSession.cwd,
      toJson(input.shellSession.env),
    ]);

    return this.parseShellStateRow(result.rows[0] as Record<string, unknown>);
  }

  async listThreadSummaries(limit?: number, sessionId?: string): Promise<readonly ThreadSummaryRecord[]> {
    const values: unknown[] = [];
    let sql = `SELECT * FROM ${this.tables.threads}`;

    if (sessionId !== undefined) {
      values.push(sessionId);
      sql += ` WHERE session_id = $${values.length}`;
    }

    sql += " ORDER BY updated_at DESC";

    if (limit !== undefined) {
      values.push(Math.max(0, limit));
      sql += ` LIMIT $${values.length}`;
    }

    const threadResult = await this.pool.query(sql, values);
    const threads = threadResult.rows.map((row) => parseThreadRow(row as Record<string, unknown>));
    if (threads.length === 0) {
      return [];
    }

    const threadIds = threads.map((thread) => thread.id);
    const placeholders = threadIds.map((_, index) => `$${index + 1}`).join(", ");

    const [messageCountResult, pendingCountResult, latestMessageResult] = await Promise.all([
      this.pool.query(`
        SELECT thread_id, COUNT(*) AS message_count
        FROM ${this.tables.messages}
        WHERE thread_id IN (${placeholders})
        GROUP BY thread_id
      `, threadIds),
      this.pool.query(`
        SELECT thread_id, COUNT(*) AS pending_input_count
        FROM ${this.tables.inputs}
        WHERE applied_at IS NULL AND thread_id IN (${placeholders})
        GROUP BY thread_id
      `, threadIds),
      this.pool.query(`
        SELECT message.*
        FROM ${this.tables.messages} AS message
        INNER JOIN (
          SELECT thread_id, MAX(sequence) AS max_sequence
          FROM ${this.tables.messages}
          WHERE thread_id IN (${placeholders})
          GROUP BY thread_id
        ) AS latest
          ON latest.thread_id = message.thread_id
         AND latest.max_sequence = message.sequence
      `, threadIds),
    ]);

    const messageCountByThreadId = new Map<string, number>();
    for (const row of messageCountResult.rows) {
      const parsedRow = parseThreadSummaryCount(row as Record<string, unknown>, "message_count");
      messageCountByThreadId.set(parsedRow.threadId, parsedRow.count);
    }

    const pendingCountByThreadId = new Map<string, number>();
    for (const row of pendingCountResult.rows) {
      const parsedRow = parseThreadSummaryCount(row as Record<string, unknown>, "pending_input_count");
      pendingCountByThreadId.set(parsedRow.threadId, parsedRow.count);
    }

    const latestMessageByThreadId = new Map<string, ThreadMessageRecord>();
    for (const row of latestMessageResult.rows) {
      const message = parseMessageRow(row as Record<string, unknown>);
      latestMessageByThreadId.set(message.threadId, message);
    }

    return threads.map((thread) => {
      return {
        thread,
        messageCount: messageCountByThreadId.get(thread.id) ?? 0,
        pendingInputCount: pendingCountByThreadId.get(thread.id) ?? 0,
        lastMessage: latestMessageByThreadId.get(thread.id),
      } satisfies ThreadSummaryRecord;
    });
  }

  async updateThread(threadId: string, update: ThreadUpdate): Promise<ThreadRecord> {
    const assignments: string[] = [];
    const values: unknown[] = [threadId];
    let index = 2;

    const push = (column: string, value: unknown, cast = "") => {
      assignments.push(`${column} = $${index}${cast}`);
      values.push(value);
      index += 1;
    };

    if (update.runtimeState !== undefined) {
      push("runtime_state", toJson(update.runtimeState ?? null), "::jsonb");
    }

    if (assignments.length === 0) {
      return this.getThread(threadId);
    }

    assignments.push("updated_at = NOW()");

    const result = await this.pool.query(
      `UPDATE ${this.tables.threads} SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
      values,
    );

    const row = result.rows[0];
    if (!row) {
      throw missingThreadError(threadId);
    }

    const record = parseThreadRow(row as Record<string, unknown>);
    await this.notifyThreadChanged(record.id);
    return record;
  }

  async loadTranscript(threadId: string): Promise<readonly ThreadMessageRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.messages} WHERE thread_id = $1 ORDER BY sequence ASC`,
      [threadId],
    );

    return result.rows.map((row) => parseMessageRow(row as Record<string, unknown>));
  }

  async enqueueInput(
    threadId: string,
    payload: ThreadInputPayload,
    deliveryMode: ThreadInputDeliveryMode = "wake",
  ): Promise<ThreadEnqueueResult> {
    return enqueueThreadInput({
      pool: this.pool,
      tables: this.tables,
      threadId,
      payload,
      deliveryMode,
      touchThread: (id, queryable) => this.touchThread(id, queryable),
      notifyThreadChanged: (id, queryable) => this.notifyThreadChanged(id, queryable),
    });
  }

  async applyPendingInputs(
    threadId: string,
    scope: ThreadInputApplyScope = "all",
  ): Promise<readonly ThreadMessageRecord[]> {
    return applyPendingThreadInputs({
      pool: this.pool,
      tables: this.tables,
      threadId,
      scope,
      touchThread: (id, queryable) => this.touchThread(id, queryable),
      notifyThreadChanged: (id, queryable) => this.notifyThreadChanged(id, queryable),
    });
  }

  async discardPendingInputs(threadId: string): Promise<number> {
    return discardPendingThreadInputs({
      pool: this.pool,
      tables: this.tables,
      threadId,
      touchThread: (id, queryable) => this.touchThread(id, queryable),
      notifyThreadChanged: (id, queryable) => this.notifyThreadChanged(id, queryable),
    });
  }

  async hasPendingInputs(threadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.tables.inputs} WHERE thread_id = $1 AND applied_at IS NULL LIMIT 1`,
      [threadId],
    );

    return result.rows.length > 0;
  }

  async hasRunnableInputs(threadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.tables.inputs}
       WHERE thread_id = $1 AND applied_at IS NULL AND delivery_mode = 'wake'
       LIMIT 1`,
      [threadId],
    );

    return result.rows.length > 0;
  }

  async hasPendingWake(threadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
       FROM ${this.tables.threads} AS thread
       INNER JOIN ${this.sessionTables.sessions} AS session
         ON session.id = thread.session_id
        AND session.current_thread_id = thread.id
       INNER JOIN ${this.sessionTables.sessionRuntimeConfig} AS config
         ON config.session_id = session.id
       WHERE thread.id = $1
         AND config.pending_wake_at IS NOT NULL
       LIMIT 1`,
      [threadId],
    );

    return result.rows.length > 0;
  }

  async promoteQueuedInputs(threadId?: string): Promise<readonly string[]> {
    return promoteQueuedThreadInputs({
      pool: this.pool,
      tables: this.tables,
      threadId,
      touchThread: (id, queryable) => this.touchThread(id, queryable),
      notifyThreadChanged: (id, queryable) => this.notifyThreadChanged(id, queryable),
    });
  }

  async requestWake(threadId: string): Promise<void> {
    const targetResult = await this.pool.query(`
      SELECT thread.session_id, session.current_thread_id
      FROM ${this.tables.threads} AS thread
      INNER JOIN ${this.sessionTables.sessions} AS session
        ON session.id = thread.session_id
      WHERE thread.id = $1
      LIMIT 1
    `, [threadId]);
    const target = targetResult.rows[0] as {session_id?: unknown; current_thread_id?: unknown} | undefined;
    if (!target || typeof target.session_id !== "string" || typeof target.current_thread_id !== "string") {
      throw missingThreadError(threadId);
    }

    await this.pool.query(`
      INSERT INTO ${this.sessionTables.sessionRuntimeConfig} (
        session_id,
        pending_wake_at
      ) VALUES (
        $1,
        NOW()
      )
      ON CONFLICT (session_id) DO UPDATE
      SET pending_wake_at = COALESCE(${this.sessionTables.sessionRuntimeConfig}.pending_wake_at, NOW()),
          updated_at = NOW()
    `, [target.session_id]);

    await this.notifyThreadChanged(target.current_thread_id);
  }

  async consumePendingWake(threadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.sessionTables.sessionRuntimeConfig}
       SET pending_wake_at = NULL,
           updated_at = NOW()
       WHERE pending_wake_at IS NOT NULL
         AND session_id = (
           SELECT thread.session_id
           FROM ${this.tables.threads} AS thread
           INNER JOIN ${this.sessionTables.sessions} AS session
             ON session.id = thread.session_id
            AND session.current_thread_id = thread.id
           WHERE thread.id = $1
           LIMIT 1
         )
       RETURNING session_id`,
      [threadId],
    );
    if (result.rows.length > 0) {
      return true;
    }

    await this.getThread(threadId);
    return false;
  }

  async appendRuntimeMessage(
    threadId: string,
    payload: ThreadRuntimeMessagePayload,
  ): Promise<ThreadMessageRecord> {
    const createdAt = new Date(payload.createdAt ?? Date.now());
    const metadataJson = serializeThreadRuntimeJsonb(payload.metadata);
    const messageJson = serializeThreadRuntimeJsonb(payload.message);
    let result: PgQueryResult;
    try {
      result = await this.pool.query(`
        INSERT INTO ${this.tables.messages} (
          id,
          thread_id,
          origin,
          source,
          channel_id,
          external_message_id,
          actor_id,
          identity_id,
          run_id,
          run_thread_id,
          created_at,
          metadata,
          message
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
          $12::jsonb,
          $13::jsonb
        )
        RETURNING *
      `, [
        randomUUID(),
        threadId,
        payload.origin ?? "runtime",
        payload.source,
        payload.channelId ?? null,
        payload.externalMessageId ?? null,
        payload.actorId ?? null,
        payload.identityId ?? null,
        payload.runId ?? null,
        payload.runId ? threadId : null,
        createdAt,
        metadataJson.json,
        messageJson.json,
      ]);
    } catch (error) {
      const jsonbError = createThreadRuntimeJsonbPersistenceError(error, {
        operation: "appendRuntimeMessage",
        table: this.tables.messages,
        fields: [
          {name: "metadata", nulCount: metadataJson.nulCount},
          {name: "message", nulCount: messageJson.nulCount},
        ],
      });
      throw jsonbError ?? error;
    }

    await this.touchThread(threadId);

    const record = parseMessageRow(result.rows[0] as Record<string, unknown>);
    await this.notifyThreadChanged(threadId);
    return record;
  }

  async createRun(threadId: string): Promise<ThreadRunRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.runs} (
        id,
        thread_id,
        status,
        started_at
      ) VALUES (
        $1,
        $2,
        'running',
        $3
      )
      RETURNING *
    `, [
      randomUUID(),
      threadId,
      new Date(),
    ]);

    await this.touchThread(threadId);

    const record = parseRunRow(result.rows[0] as Record<string, unknown>);
    await this.notifyThreadChanged(threadId);
    return record;
  }

  async getRun(runId: string): Promise<ThreadRunRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.runs} WHERE id = $1`,
      [runId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown run ${runId}`);
    }

    return parseRunRow(row as Record<string, unknown>);
  }

  async completeRun(runId: string): Promise<ThreadRunRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runs}
      SET
        status = CASE WHEN abort_requested_at IS NULL THEN 'completed' ELSE 'failed' END,
        finished_at = $2,
        error = CASE
          WHEN abort_requested_at IS NULL THEN NULL
          ELSE COALESCE(abort_reason, 'Run aborted before completion.')
        END
      WHERE id = $1 AND status = 'running'
      RETURNING *
    `, [
      runId,
      new Date(),
    ]);

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown run ${runId}`);
    }

    const record = parseRunRow(row as Record<string, unknown>);
    await this.notifyThreadChanged(record.threadId);
    return record;
  }

  async failRunIfRunning(runId: string, error?: string): Promise<ThreadRunRecord | null> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runs}
      SET status = 'failed', finished_at = $2, error = $3
      WHERE id = $1 AND status = 'running'
      RETURNING *
    `, [
      runId,
      new Date(),
      error ?? null,
    ]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const record = parseRunRow(row as Record<string, unknown>);
    await this.notifyThreadChanged(record.threadId);
    return record;
  }

  async listRuns(threadId: string): Promise<readonly ThreadRunRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.runs} WHERE thread_id = $1 ORDER BY started_at ASC`,
      [threadId],
    );

    return result.rows.map((row) => parseRunRow(row as Record<string, unknown>));
  }

  async listRunningRuns(): Promise<readonly ThreadRunRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.runs} WHERE status = 'running' ORDER BY started_at ASC`,
    );

    return result.rows.map((row) => parseRunRow(row as Record<string, unknown>));
  }

  async createToolJob(input: CreateThreadToolJobInput): Promise<ThreadToolJobRecord> {
    const startedAt = input.startedAt ?? Date.now();
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.toolJobs} (
        id,
        thread_id,
        run_id,
        run_thread_id,
        kind,
        status,
        summary,
        started_at,
        result,
        error,
        status_reason,
        progress
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb,
        $10,
        $11,
        $12::jsonb
      )
      RETURNING *
    `, [
      input.id,
      input.threadId,
      input.runId ?? null,
      input.runId ? input.threadId : null,
      input.kind,
      input.status ?? "running",
      input.summary ?? "",
      new Date(startedAt),
      toJson(input.result),
      input.error ?? null,
      input.statusReason ?? null,
      toJson(input.progress),
    ]);

    await this.touchThread(input.threadId);

    const record = parseToolJobRow(result.rows[0] as Record<string, unknown>);
    await this.notifyThreadChanged(record.threadId);
    return record;
  }

  async getToolJob(jobId: string): Promise<ThreadToolJobRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.toolJobs} WHERE id = $1`,
      [jobId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown tool job ${jobId}`);
    }

    return parseToolJobRow(row as Record<string, unknown>);
  }

  async listToolJobs(threadId: string): Promise<readonly ThreadToolJobRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.toolJobs} WHERE thread_id = $1 ORDER BY started_at ASC`,
      [threadId],
    );

    return result.rows.map((row) => parseToolJobRow(row as Record<string, unknown>));
  }

  async updateToolJob(jobId: string, update: ThreadToolJobUpdate): Promise<ThreadToolJobRecord> {
    const assignments: string[] = [];
    const values: unknown[] = [jobId];
    let index = 2;

    const push = (column: string, value: unknown, cast = "") => {
      assignments.push(`${column} = $${index}${cast}`);
      values.push(value);
      index += 1;
    };

    if (update.runId !== undefined) {
      assignments.push(`run_id = $${index}`);
      assignments.push(`run_thread_id = CASE WHEN $${index} IS NULL THEN NULL ELSE thread_id END`);
      values.push(update.runId ?? null);
      index += 1;
    }
    if (update.status !== undefined) {
      push("status", update.status);
    }
    if (update.summary !== undefined) {
      push("summary", update.summary);
    }
    if (update.startedAt !== undefined) {
      push("started_at", new Date(update.startedAt));
    }
    if (update.finishedAt !== undefined) {
      push("finished_at", update.finishedAt === null ? null : new Date(update.finishedAt));
    }
    if (update.durationMs !== undefined) {
      push("duration_ms", update.durationMs ?? null);
    }
    if (update.result !== undefined) {
      push("result", update.result === null ? null : toJson(update.result), "::jsonb");
    }
    if (update.error !== undefined) {
      push("error", update.error ?? null);
    }
    if (update.statusReason !== undefined) {
      push("status_reason", update.statusReason ?? null);
    }
    if (update.progress !== undefined) {
      push("progress", update.progress === null ? null : toJson(update.progress), "::jsonb");
    }

    if (assignments.length === 0) {
      return this.getToolJob(jobId);
    }

    const result = await this.pool.query(
      `UPDATE ${this.tables.toolJobs} SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
      values,
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown tool job ${jobId}`);
    }

    const record = parseToolJobRow(row as Record<string, unknown>);
    await this.touchThread(record.threadId);
    await this.notifyThreadChanged(record.threadId);
    return record;
  }

  async markRunningToolJobsLost(reason = "The runtime restarted before the background tool job finished."): Promise<number> {
    const runningResult = await this.pool.query(
      `SELECT id, thread_id, started_at FROM ${this.tables.toolJobs} WHERE status = 'running'`,
    );
    if (runningResult.rows.length === 0) {
      return 0;
    }

    const finishedAt = Date.now();
    const threadIds = new Set<string>();

    for (const row of runningResult.rows) {
      const parsedRow = parseRunningToolJobLossRow(row as Record<string, unknown>);
      const jobId = parsedRow.id;
      const threadId = parsedRow.threadId;
      const startedAt = parsedRow.startedAt;
      threadIds.add(threadId);

      await this.pool.query(`
        UPDATE ${this.tables.toolJobs}
        SET
          status = 'lost',
          finished_at = $2,
          duration_ms = $3,
          status_reason = COALESCE(status_reason, $4)
        WHERE id = $1
      `, [
        jobId,
        new Date(finishedAt),
        Math.max(0, finishedAt - startedAt),
        reason,
      ]);
    }

    await Promise.all([...threadIds].map(async (threadId) => {
      await this.touchThread(threadId);
      await this.notifyThreadChanged(threadId);
    }));

    return runningResult.rows.length;
  }

  async listPendingInputs(threadId: string): Promise<readonly ThreadInputRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.inputs}
      WHERE thread_id = $1 AND applied_at IS NULL
      ORDER BY input_order ASC
    `, [threadId]);

    return result.rows.map((row) => parseInputRow(row as Record<string, unknown>));
  }

  async requestRunAbort(threadId: string, reason = "Aborted by runtime request."): Promise<ThreadRunRecord | null> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runs}
      SET abort_requested_at = NOW(), abort_reason = $2
      WHERE id = (
        SELECT id
        FROM ${this.tables.runs}
        WHERE thread_id = $1 AND status = 'running'
        ORDER BY started_at DESC
        LIMIT 1
      )
      RETURNING *
    `, [
      threadId,
      reason,
    ]);

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const record = parseRunRow(row as Record<string, unknown>);
    await this.notifyThreadChanged(record.threadId);
    return record;
  }
}
