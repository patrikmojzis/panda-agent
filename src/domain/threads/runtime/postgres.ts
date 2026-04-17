import {createHash, randomUUID} from "node:crypto";

import {resolveModelSelector} from "../../../kernel/models/model-selector.js";
import {addConstraint, alterIfSupported, assertIntegrityChecks} from "../../../lib/postgres-integrity.js";
import type {ThreadLease, ThreadLeaseManager} from "./coordinator.js";
import {
  buildThreadRuntimeTableNames,
  CREATE_RUNTIME_SCHEMA_SQL,
  quoteIdentifier,
  type ThreadRuntimeTableNames,
  toJson,
  validateIdentifier,
} from "./postgres-shared.js";
import {buildThreadRuntimeSchemaSql} from "./postgres-schema.js";
import {parseBashJobRow, parseInputRow, parseMessageRow, parseRunRow, parseThreadRow} from "./postgres-rows.js";
import {
  applyPendingThreadInputs,
  discardPendingThreadInputs,
  enqueueThreadInput,
  promoteQueuedThreadInputs,
} from "./postgres-inputs.js";
import type {PgPoolLike, PgQueryable} from "./postgres-db.js";
import type {ThreadEnqueueResult, ThreadRuntimeStore} from "./store.js";
import {
  type CreateThreadBashJobInput,
  type CreateThreadInput,
  missingThreadError,
  type ThreadBashJobRecord,
  type ThreadBashJobUpdate,
  type ThreadInputDeliveryMode,
  type ThreadInputPayload,
  type ThreadInputRecord,
  type ThreadMessageRecord,
  type ThreadRecord,
  type ThreadRunRecord,
  type ThreadRuntimeMessagePayload,
  type ThreadSummaryRecord,
  type ThreadUpdate,
} from "./types.js";
import {buildIdentityTableNames} from "../../../domain/identity/postgres-shared.js";
import {buildSessionTableNames} from "../../../domain/sessions/postgres-shared.js";

interface PostgresThreadRuntimeStoreOptions {
  pool: PgPoolLike;
}

export interface ThreadRuntimeNotification {
  threadId: string;
}

export function buildThreadRuntimeNotificationChannel(): string {
  return validateIdentifier("runtime_events");
}

export function parseThreadRuntimeNotification(payload: string): ThreadRuntimeNotification | null {
  try {
    const parsed = JSON.parse(payload) as Partial<ThreadRuntimeNotification>;
    if (!parsed || typeof parsed.threadId !== "string" || parsed.threadId.length === 0) {
      return null;
    }

    return {
      threadId: parsed.threadId,
    };
  } catch {
    return null;
  }
}

export class PostgresThreadRuntimeStore implements ThreadRuntimeStore {
  private readonly pool: PgPoolLike;
  private readonly tables: ThreadRuntimeTableNames;
  private readonly notificationChannel: string;
  private readonly identityTableName: string;
  private readonly sessionTableName: string;

  constructor(options: PostgresThreadRuntimeStoreOptions) {
    this.pool = options.pool;
    const identityTables = buildIdentityTableNames();
    const sessionTables = buildSessionTableNames();
    this.tables = buildThreadRuntimeTableNames();
    this.notificationChannel = buildThreadRuntimeNotificationChannel();
    this.identityTableName = identityTables.identities;
    this.sessionTableName = sessionTables.sessions;
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
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(buildThreadRuntimeSchemaSql(this.tables, this.sessionTableName, this.identityTableName));
    await assertIntegrityChecks(this.pool, "Thread runtime schema", [
      {
        label: "agent_sessions.current_thread_id orphaned from threads.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.sessionTableName} AS session
          LEFT JOIN ${this.tables.threads} AS thread
            ON thread.id = session.current_thread_id
          WHERE thread.id IS NULL
        `,
      },
      {
        label: "agent_sessions.current_thread_id bound to a thread from another session",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.sessionTableName} AS session
          INNER JOIN ${this.tables.threads} AS thread
            ON thread.id = session.current_thread_id
          WHERE thread.session_id <> session.id
        `,
      },
      {
        label: "messages.run_id orphaned from runs.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.messages} AS message
          LEFT JOIN ${this.tables.runs} AS run
            ON run.id = message.run_id
          WHERE message.run_id IS NOT NULL
            AND run.id IS NULL
        `,
      },
      {
        label: "messages.run_id bound to a run from another thread",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.messages} AS message
          INNER JOIN ${this.tables.runs} AS run
            ON run.id = message.run_id
          WHERE message.run_id IS NOT NULL
            AND run.thread_id <> message.thread_id
        `,
      },
      {
        label: "bash_jobs.run_id bound to a run from another thread",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.bashJobs} AS job
          INNER JOIN ${this.tables.runs} AS run
            ON run.id = job.run_id
          WHERE job.run_id IS NOT NULL
            AND run.thread_id <> job.thread_id
        `,
      },
    ]);
    await this.pool.query(`
      UPDATE ${this.tables.messages}
      SET run_thread_id = NULL
      WHERE run_id IS NULL
        AND run_thread_id IS NOT NULL
    `);
    await this.pool.query(`
      UPDATE ${this.tables.messages}
      SET run_thread_id = run.thread_id
      FROM ${this.tables.runs} AS run
      WHERE ${this.tables.messages}.run_id IS NOT NULL
        AND run.id = ${this.tables.messages}.run_id
        AND (
          ${this.tables.messages}.run_thread_id IS NULL
          OR ${this.tables.messages}.run_thread_id <> run.thread_id
        )
    `);
    await this.pool.query(`
      UPDATE ${this.tables.bashJobs}
      SET run_thread_id = NULL
      WHERE run_id IS NULL
        AND run_thread_id IS NOT NULL
    `);
    await this.pool.query(`
      UPDATE ${this.tables.bashJobs}
      SET run_thread_id = run.thread_id
      FROM ${this.tables.runs} AS run
      WHERE ${this.tables.bashJobs}.run_id IS NOT NULL
        AND run.id = ${this.tables.bashJobs}.run_id
        AND (
          ${this.tables.bashJobs}.run_thread_id IS NULL
          OR ${this.tables.bashJobs}.run_thread_id <> run.thread_id
        )
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.messages}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_messages_run_fk`)}
      FOREIGN KEY (run_id)
      REFERENCES ${this.tables.runs}(id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.messages}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_messages_run_scope_check`)}
      CHECK (
        (
          run_id IS NULL
          AND run_thread_id IS NULL
        ) OR (
          run_id IS NOT NULL
          AND run_thread_id = thread_id
        )
      )
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.messages}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_messages_run_scope_fk`)}
      FOREIGN KEY (run_thread_id, run_id)
      REFERENCES ${this.tables.runs}(thread_id, id)
      ON DELETE SET NULL
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.bashJobs}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_bash_jobs_run_scope_check`)}
      CHECK (
        (
          run_id IS NULL
          AND run_thread_id IS NULL
        ) OR (
          run_id IS NOT NULL
          AND run_thread_id = thread_id
        )
      )
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.bashJobs}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_bash_jobs_run_scope_fk`)}
      FOREIGN KEY (run_thread_id, run_id)
      REFERENCES ${this.tables.runs}(thread_id, id)
      ON DELETE SET NULL
    `);
    await alterIfSupported(this.pool, `
      ALTER TABLE ${this.sessionTableName}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_agent_sessions_current_thread_fk`)}
      FOREIGN KEY (id, current_thread_id)
      REFERENCES ${this.tables.threads}(session_id, id)
      DEFERRABLE INITIALLY DEFERRED
    `);
  }

  async createThreadRecord(input: CreateThreadInput, queryable: PgQueryable = this.pool): Promise<ThreadRecord> {
    const sessionId = input.sessionId?.trim();
    if (!sessionId) {
      throw new Error(`Thread ${input.id} is missing sessionId.`);
    }
    const model = input.model === undefined ? null : resolveModelSelector(input.model).canonical;

    const result = await queryable.query(`
      INSERT INTO ${this.tables.threads} (
        id,
        session_id,
        system_prompt,
        max_turns,
        context,
        runtime_state,
        inference_projection,
        prompt_cache_key,
        model,
        temperature,
        thinking
      ) VALUES (
        $1,
        $2,
        $3::jsonb,
        $4,
        $5::jsonb,
        $6::jsonb,
        $7::jsonb,
        $8,
        $9,
        $10,
        $11
      )
      ON CONFLICT (id) DO UPDATE
      SET system_prompt = EXCLUDED.system_prompt,
          max_turns = EXCLUDED.max_turns,
          context = EXCLUDED.context,
          runtime_state = EXCLUDED.runtime_state,
          inference_projection = EXCLUDED.inference_projection,
          prompt_cache_key = EXCLUDED.prompt_cache_key,
          model = EXCLUDED.model,
          temperature = EXCLUDED.temperature,
          thinking = EXCLUDED.thinking,
          updated_at = NOW()
      WHERE ${this.tables.threads}.session_id = EXCLUDED.session_id
        AND ${this.tables.threads}.system_prompt IS NULL
        AND ${this.tables.threads}.max_turns IS NULL
        AND ${this.tables.threads}.context IS NULL
        AND ${this.tables.threads}.runtime_state IS NULL
        AND ${this.tables.threads}.inference_projection IS NULL
        AND ${this.tables.threads}.prompt_cache_key IS NULL
        AND ${this.tables.threads}.model IS NULL
        AND ${this.tables.threads}.temperature IS NULL
        AND ${this.tables.threads}.thinking IS NULL
        AND ${this.tables.threads}.pending_wake_at IS NULL
      RETURNING *
    `, [
      input.id,
      sessionId,
      toJson(input.systemPrompt),
      input.maxTurns ?? null,
      toJson(input.context),
      toJson(input.runtimeState),
      toJson(input.inferenceProjection),
      input.promptCacheKey ?? null,
      model,
      input.temperature ?? null,
      input.thinking ?? null,
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
      const parsedRow = row as Record<string, unknown>;
      messageCountByThreadId.set(
        String(parsedRow.thread_id),
        Number(parsedRow.message_count ?? 0),
      );
    }

    const pendingCountByThreadId = new Map<string, number>();
    for (const row of pendingCountResult.rows) {
      const parsedRow = row as Record<string, unknown>;
      pendingCountByThreadId.set(
        String(parsedRow.thread_id),
        Number(parsedRow.pending_input_count ?? 0),
      );
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

    if (update.systemPrompt !== undefined) {
      push("system_prompt", toJson(update.systemPrompt), "::jsonb");
    }

    if (update.maxTurns !== undefined) {
      push("max_turns", update.maxTurns);
    }

    if (update.context !== undefined) {
      push("context", toJson(update.context), "::jsonb");
    }

    if (update.runtimeState !== undefined) {
      push("runtime_state", toJson(update.runtimeState ?? null), "::jsonb");
    }

    if (update.inferenceProjection !== undefined) {
      push("inference_projection", toJson(update.inferenceProjection ?? null), "::jsonb");
    }

    if (update.promptCacheKey !== undefined) {
      push("prompt_cache_key", update.promptCacheKey);
    }

    if (update.model !== undefined) {
      push("model", resolveModelSelector(update.model).canonical);
    }

    if (update.temperature !== undefined) {
      push("temperature", update.temperature);
    }

    if (update.thinking !== undefined) {
      push("thinking", update.thinking);
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

  async applyPendingInputs(threadId: string): Promise<readonly ThreadMessageRecord[]> {
    return applyPendingThreadInputs({
      pool: this.pool,
      tables: this.tables,
      threadId,
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
      `SELECT 1 FROM ${this.tables.threads}
       WHERE id = $1 AND pending_wake_at IS NOT NULL
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
    const result = await this.pool.query(
      `UPDATE ${this.tables.threads}
       SET pending_wake_at = COALESCE(pending_wake_at, NOW())
       WHERE id = $1
       RETURNING id`,
      [threadId],
    );
    if (result.rows.length === 0) {
      throw missingThreadError(threadId);
    }

    await this.notifyThreadChanged(threadId);
  }

  async consumePendingWake(threadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE ${this.tables.threads}
       SET pending_wake_at = NULL
       WHERE id = $1 AND pending_wake_at IS NOT NULL
       RETURNING id`,
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
    const result = await this.pool.query(`
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
      toJson(payload.metadata),
      toJson(payload.message),
    ]);

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

  async createBashJob(input: CreateThreadBashJobInput): Promise<ThreadBashJobRecord> {
    const startedAt = input.startedAt ?? Date.now();
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.bashJobs} (
        id,
        thread_id,
        run_id,
        run_thread_id,
        status,
        command,
        mode,
        initial_cwd,
        started_at,
        timed_out,
        stdout,
        stderr,
        stdout_chars,
        stderr_chars,
        stdout_truncated,
        stderr_truncated,
        stdout_persisted,
        stderr_persisted,
        stdout_path,
        stderr_path,
        tracked_env_keys,
        status_reason
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
        $12,
        $13,
        $14,
        $15,
        $16,
        $17,
        $18,
        $19,
        $20,
        $21::jsonb,
        $22
      )
      RETURNING *
    `, [
      input.id,
      input.threadId,
      input.runId ?? null,
      input.runId ? input.threadId : null,
      input.status ?? "running",
      input.command,
      input.mode,
      input.initialCwd,
      new Date(startedAt),
      input.timedOut ?? false,
      input.stdout ?? "",
      input.stderr ?? "",
      input.stdoutChars ?? 0,
      input.stderrChars ?? 0,
      input.stdoutTruncated ?? false,
      input.stderrTruncated ?? false,
      input.stdoutPersisted ?? false,
      input.stderrPersisted ?? false,
      input.stdoutPath ?? null,
      input.stderrPath ?? null,
      toJson(input.trackedEnvKeys ?? []),
      input.statusReason ?? null,
    ]);

    await this.touchThread(input.threadId);

    const record = parseBashJobRow(result.rows[0] as Record<string, unknown>);
    await this.notifyThreadChanged(record.threadId);
    return record;
  }

  async getBashJob(jobId: string): Promise<ThreadBashJobRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.bashJobs} WHERE id = $1`,
      [jobId],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown bash job ${jobId}`);
    }

    return parseBashJobRow(row as Record<string, unknown>);
  }

  async listBashJobs(threadId: string): Promise<readonly ThreadBashJobRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.bashJobs} WHERE thread_id = $1 ORDER BY started_at ASC`,
      [threadId],
    );

    return result.rows.map((row) => parseBashJobRow(row as Record<string, unknown>));
  }

  async updateBashJob(jobId: string, update: ThreadBashJobUpdate): Promise<ThreadBashJobRecord> {
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
    if (update.initialCwd !== undefined) {
      push("initial_cwd", update.initialCwd);
    }
    if (update.finalCwd !== undefined) {
      push("final_cwd", update.finalCwd ?? null);
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
    if (update.exitCode !== undefined) {
      push("exit_code", update.exitCode ?? null);
    }
    if (update.signal !== undefined) {
      push("signal", update.signal ?? null);
    }
    if (update.timedOut !== undefined) {
      push("timed_out", update.timedOut);
    }
    if (update.stdout !== undefined) {
      push("stdout", update.stdout);
    }
    if (update.stderr !== undefined) {
      push("stderr", update.stderr);
    }
    if (update.stdoutChars !== undefined) {
      push("stdout_chars", update.stdoutChars);
    }
    if (update.stderrChars !== undefined) {
      push("stderr_chars", update.stderrChars);
    }
    if (update.stdoutTruncated !== undefined) {
      push("stdout_truncated", update.stdoutTruncated);
    }
    if (update.stderrTruncated !== undefined) {
      push("stderr_truncated", update.stderrTruncated);
    }
    if (update.stdoutPersisted !== undefined) {
      push("stdout_persisted", update.stdoutPersisted);
    }
    if (update.stderrPersisted !== undefined) {
      push("stderr_persisted", update.stderrPersisted);
    }
    if (update.stdoutPath !== undefined) {
      push("stdout_path", update.stdoutPath ?? null);
    }
    if (update.stderrPath !== undefined) {
      push("stderr_path", update.stderrPath ?? null);
    }
    if (update.trackedEnvKeys !== undefined) {
      push("tracked_env_keys", toJson(update.trackedEnvKeys ?? []), "::jsonb");
    }
    if (update.statusReason !== undefined) {
      push("status_reason", update.statusReason ?? null);
    }

    if (assignments.length === 0) {
      return this.getBashJob(jobId);
    }

    const result = await this.pool.query(
      `UPDATE ${this.tables.bashJobs} SET ${assignments.join(", ")} WHERE id = $1 RETURNING *`,
      values,
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown bash job ${jobId}`);
    }

    const record = parseBashJobRow(row as Record<string, unknown>);
    await this.touchThread(record.threadId);
    await this.notifyThreadChanged(record.threadId);
    return record;
  }

  async markRunningBashJobsLost(reason = "The runtime restarted before the background bash job finished."): Promise<number> {
    const runningResult = await this.pool.query(
      `SELECT id, thread_id, started_at FROM ${this.tables.bashJobs} WHERE status = 'running'`,
    );
    if (runningResult.rows.length === 0) {
      return 0;
    }

    const finishedAt = Date.now();
    const threadIds = new Set<string>();

    for (const row of runningResult.rows) {
      const parsedRow = row as Record<string, unknown>;
      const jobId = String(parsedRow.id);
      const threadId = String(parsedRow.thread_id);
      const startedAt = new Date(String(parsedRow.started_at)).getTime();
      threadIds.add(threadId);

      await this.pool.query(`
        UPDATE ${this.tables.bashJobs}
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

export class PostgresThreadLeaseManager implements ThreadLeaseManager {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async tryAcquire(threadId: string): Promise<ThreadLease | null> {
    const client = await this.pool.connect();
    const [keyA, keyB] = hashThreadLeaseKey(threadId);

    try {
      const result = await client.query(
        "SELECT pg_try_advisory_lock($1, $2) AS acquired",
        [keyA, keyB],
      );

      const acquired = Boolean((result.rows[0] as Record<string, unknown> | undefined)?.acquired);
      if (!acquired) {
        client.release();
        return null;
      }

      let released = false;
      return {
        threadId,
        release: async () => {
          if (released) {
            return;
          }

          released = true;

          try {
            await client.query("SELECT pg_advisory_unlock($1, $2)", [keyA, keyB]);
          } finally {
            client.release();
          }
        },
      };
    } catch (error) {
      client.release();
      throw error;
    }
  }
}

function hashThreadLeaseKey(threadId: string): readonly [number, number] {
  const digest = createHash("sha256").update(threadId).digest();
  return [
    digest.readInt32BE(0),
    digest.readInt32BE(4),
  ] as const;
}
