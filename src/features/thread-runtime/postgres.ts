import { createHash, randomUUID } from "node:crypto";

import type { ThreadLease, ThreadLeaseManager } from "./coordinator.js";
import {
  buildThreadRuntimeTableNames,
  validateIdentifier,
  toJson,
  type ThreadRuntimeTableNames,
} from "./postgres-shared.js";
import { buildThreadRuntimeSchemaSql } from "./postgres-schema.js";
import { parseInputRow, parseMessageRow, parseRunRow, parseThreadRow } from "./postgres-rows.js";
import {
  applyPendingThreadInputs,
  discardPendingThreadInputs,
  enqueueThreadInput,
  promoteQueuedThreadInputs,
} from "./postgres-inputs.js";
import type { PgPoolLike, PgQueryable } from "./postgres-db.js";
import type { ThreadEnqueueResult, ThreadRuntimeStore } from "./store.js";
import {
  missingThreadError,
  type CreateThreadInput,
  type ThreadInputDeliveryMode,
  type ThreadInputPayload,
  type ThreadInputRecord,
  type ThreadMessageRecord,
  type ThreadRunRecord,
  type ThreadRuntimeMessagePayload,
  type ThreadRecord,
  type ThreadSummaryRecord,
  type ThreadUpdate,
} from "./types.js";
import { PostgresIdentityStore, type PostgresIdentityStoreOptions } from "../identity/postgres.js";
import { buildIdentityTableNames } from "../identity/postgres-shared.js";
import { DEFAULT_IDENTITY_ID } from "../identity/types.js";

interface PostgresThreadRuntimeStoreOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
  identityStore?: PostgresIdentityStore;
}

export interface ThreadRuntimeNotification {
  threadId: string;
}

export function buildThreadRuntimeNotificationChannel(prefix = "thread_runtime"): string {
  return validateIdentifier(`${prefix}_events`);
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
  readonly identityStore: PostgresIdentityStore;

  constructor(options: PostgresThreadRuntimeStoreOptions) {
    this.pool = options.pool;
    const tablePrefix = options.tablePrefix ?? "thread_runtime";
    const identityTables = buildIdentityTableNames(tablePrefix);
    this.tables = buildThreadRuntimeTableNames(tablePrefix);
    this.notificationChannel = buildThreadRuntimeNotificationChannel(tablePrefix);
    this.identityStore = options.identityStore ?? new PostgresIdentityStore({
      pool: options.pool,
      tablePrefix,
    } satisfies PostgresIdentityStoreOptions);
    this.identityTableName = identityTables.identities;
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
    await this.identityStore.ensureSchema();
    await this.pool.query(buildThreadRuntimeSchemaSql(this.tables, this.identityTableName));
  }

  async createThread(input: CreateThreadInput): Promise<ThreadRecord> {
    const identityId = input.identityId ?? DEFAULT_IDENTITY_ID;
    await this.identityStore.getIdentity(identityId);

    const result = await this.pool.query(`
      INSERT INTO ${this.tables.threads} (
        id,
        identity_id,
        agent_key,
        system_prompt,
        max_turns,
        context,
        max_input_tokens,
        prompt_cache_key,
        provider,
        model,
        temperature,
        thinking
      ) VALUES (
        $1,
        $2,
        $3,
        $4::jsonb,
        $5,
        $6::jsonb,
        $7,
        $8,
        $9,
        $10,
        $11,
        $12
      )
      RETURNING *
    `, [
      input.id,
      identityId,
      input.agentKey,
      toJson(input.systemPrompt),
      input.maxTurns ?? null,
      toJson(input.context),
      input.maxInputTokens ?? null,
      input.promptCacheKey ?? null,
      input.provider ?? null,
      input.model ?? null,
      input.temperature ?? null,
      input.thinking ?? null,
    ]);

    const record = parseThreadRow(result.rows[0] as Record<string, unknown>);
    await this.notifyThreadChanged(record.id);
    return record;
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

  async listThreadSummaries(limit?: number, identityId?: string): Promise<readonly ThreadSummaryRecord[]> {
    const values: unknown[] = [];
    let sql = `SELECT * FROM ${this.tables.threads}`;

    if (identityId !== undefined) {
      values.push(identityId);
      sql += ` WHERE identity_id = $${values.length}`;
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

    if (update.agentKey !== undefined) {
      push("agent_key", update.agentKey);
    }

    if (update.systemPrompt !== undefined) {
      push("system_prompt", toJson(update.systemPrompt), "::jsonb");
    }

    if (update.maxTurns !== undefined) {
      push("max_turns", update.maxTurns);
    }

    if (update.context !== undefined) {
      push("context", toJson(update.context), "::jsonb");
    }

    if (update.maxInputTokens !== undefined) {
      push("max_input_tokens", update.maxInputTokens);
    }

    if (update.promptCacheKey !== undefined) {
      push("prompt_cache_key", update.promptCacheKey);
    }

    if (update.provider !== undefined) {
      push("provider", update.provider);
    }

    if (update.model !== undefined) {
      push("model", update.model);
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

  async promoteQueuedInputs(threadId?: string): Promise<readonly string[]> {
    return promoteQueuedThreadInputs({
      pool: this.pool,
      tables: this.tables,
      threadId,
      touchThread: (id, queryable) => this.touchThread(id, queryable),
      notifyThreadChanged: (id, queryable) => this.notifyThreadChanged(id, queryable),
    });
  }

  async appendRuntimeMessage(
    threadId: string,
    payload: ThreadRuntimeMessagePayload,
  ): Promise<ThreadMessageRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.messages} (
        id,
        thread_id,
        origin,
        source,
        channel_id,
        external_message_id,
        actor_id,
        run_id,
        created_at,
        metadata,
        message
      ) VALUES (
        $1,
        $2,
        'runtime',
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::jsonb,
        $10::jsonb
      )
      RETURNING *
    `, [
      randomUUID(),
      threadId,
      payload.source,
      payload.channelId ?? null,
      payload.externalMessageId ?? null,
      payload.actorId ?? null,
      payload.runId ?? null,
      new Date(),
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
