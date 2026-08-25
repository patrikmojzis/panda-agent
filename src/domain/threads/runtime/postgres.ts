import {toJson} from "../../../lib/postgres-values.js";
import {randomUUID} from "node:crypto";

import {
    buildThreadRuntimeTableNames, type ThreadRuntimeTableNames} from "./postgres-shared.js";
import {buildThreadRuntimeNotificationChannel, type ThreadRuntimeNotification} from "./postgres-notifications.js";
import {
    parseInputRow,
    parsePendingInputRow,
    parseMessageRow,
    parseRunRow,
    parseThreadRow,
    parseToolJobRow,
} from "./postgres-rows.js";
import {
    applyPendingThreadInputs,
    discardPendingThreadInputs,
    enqueueSessionThreadInput,
    enqueueThreadInput,
    promoteQueuedThreadInputs,
} from "./postgres-inputs.js";
import type {PgPoolLike, PgQueryResult, PgQueryable} from "../../../lib/postgres-query.js";
import {withTransaction} from "../../../lib/postgres-transaction.js";
import {
  StaleThreadCompactionError,
  ThreadRunClaimLostError,
  ThreadToolJobOwnershipLostError,
  type ThreadEnqueueResult,
  type ThreadRuntimeStore,
} from "./store.js";
import type {DurableShellSession, ThreadShellStateKey, ThreadShellStateRecord, ThreadShellStateStore} from "./shell-state-store.js";
import {
    type CreateThreadInput,
    type CreateThreadToolJobInput,
    type ThreadCompactionCommit,
    type ThreadChannelMediaFilter,
    type ThreadChannelMediaRecord,
    type ThreadChannelMessageFilter,
    missingThreadError,
    type ThreadInputDeliveryMode,
    type ThreadEnqueueOptions,
    type ThreadInputPayload,
    type ThreadInputRecord,
    type ThreadPendingInputRecord,
    type ThreadMessageRecord,
    type ThreadRecord,
    type ThreadRunOwner,
    type ThreadRunRecord,
    type ThreadRuntimeMessagePayload,
    type ThreadSummaryRecord,
    type ThreadTranscriptPage,
    type ThreadTranscriptPageOptions,
    type ThreadTranscriptSnapshot,
    type ThreadToolJobRecord,
    type ThreadToolJobUpdate,
    type ThreadRuntimeStateUpdate,
} from "./types.js";
import type {MediaDescriptor} from "../../channels/types.js";
import {buildSessionTableNames, type SessionTableNames} from "../../sessions/postgres-shared.js";
import {POSTGRES_CONNECTOR_LEASE_TABLE} from "../../connector-leases/postgres-schema.js";
import {
  createThreadRuntimeJsonbPersistenceError,
  serializeThreadRuntimeJsonb,
} from "./postgres-jsonb-safety.js";
import {
  hasCompactBoundaryKind,
  projectTranscriptForRun,
} from "../../../kernel/transcript/checkpoint.js";
import {
  assertExclusiveThreadAccess,
  buildActiveThreadRunGuardCte,
  buildOwnedToolJobGuardCte,
  completeOwnedThreadRun,
  failOrphanedThreadRuns,
  failOwnedThreadRun,
  isRunnableThread,
  isThreadRunActive,
  lockThreadRunOwner,
  listRunnableThreadIds as loadRunnableThreadIds,
  markOrphanedThreadToolJobsLost,
  takeOwnedThreadRunBoundary,
  tryStartThreadRun,
} from "./postgres-run-claims.js";

interface PostgresThreadRuntimeStoreOptions {
  pool: PgPoolLike;
}

const MAX_CHANNEL_MEDIA_SCAN_ROWS = 5_000;
const DEFAULT_TRANSCRIPT_PAGE_SIZE = 200;
const MAX_TRANSCRIPT_PAGE_SIZE = 500;

function readMediaDescriptor(value: unknown): MediaDescriptor | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string"
    || !record.id.trim()
    || typeof record.source !== "string"
    || !record.source.trim()
    || typeof record.connectorKey !== "string"
    || !record.connectorKey.trim()
    || typeof record.mimeType !== "string"
    || !record.mimeType.trim()
    || typeof record.sizeBytes !== "number"
    || !Number.isFinite(record.sizeBytes)
    || typeof record.localPath !== "string"
    || !record.localPath.trim()
    || typeof record.createdAt !== "number"
    || !Number.isFinite(record.createdAt)
  ) {
    return null;
  }

  return {
    id: record.id,
    source: record.source,
    connectorKey: record.connectorKey,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    localPath: record.localPath,
    ...(typeof record.originalFilename === "string" && record.originalFilename.trim()
      ? {originalFilename: record.originalFilename}
      : {}),
    ...(typeof record.metadata === "object" && record.metadata !== null && !Array.isArray(record.metadata)
      ? {metadata: record.metadata as MediaDescriptor["metadata"]}
      : {}),
    createdAt: record.createdAt,
  };
}

function readSourceMediaFromMessage(message: ThreadMessageRecord, source: string): readonly MediaDescriptor[] {
  const metadata = message.metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return [];
  }

  const sourceMetadata = (metadata as Record<string, unknown>)[source];
  if (typeof sourceMetadata !== "object" || sourceMetadata === null || Array.isArray(sourceMetadata)) {
    return [];
  }

  const media = (sourceMetadata as Record<string, unknown>).media;
  if (!Array.isArray(media)) {
    return [];
  }

  return media.flatMap((entry) => {
    const descriptor = readMediaDescriptor(entry);
    return descriptor ? [descriptor] : [];
  });
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
      JSON.stringify({ kind: "thread_changed", threadId } satisfies ThreadRuntimeNotification),
    ]);
  }

  private async touchThread(threadId: string, queryable: PgQueryable = this.pool): Promise<void> {
    await queryable.query(
      `UPDATE ${this.tables.threads} SET updated_at = NOW() WHERE id = $1`,
      [threadId],
    );
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
        replaces_thread_id,
        runtime_state
      ) VALUES (
        $1,
        $2,
        $3,
        $4::jsonb
      )
      ON CONFLICT (id) DO UPDATE
      SET runtime_state = EXCLUDED.runtime_state,
          updated_at = NOW()
      WHERE ${this.tables.threads}.session_id = EXCLUDED.session_id
        AND (
          ${this.tables.threads}.replaces_thread_id = EXCLUDED.replaces_thread_id
          OR (
            ${this.tables.threads}.replaces_thread_id IS NULL
            AND EXCLUDED.replaces_thread_id IS NULL
          )
        )
        AND ${this.tables.threads}.runtime_state IS NULL
      RETURNING *
    `, [
      input.id,
      sessionId,
      input.replacesThreadId ?? null,
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

  async upsertShellSession(
    input: ThreadShellStateKey & {runId: string; shellSession: DurableShellSession},
  ): Promise<ThreadShellStateRecord> {
    const result = await this.pool.query(`
      WITH ${buildActiveThreadRunGuardCte(this.tables, {
        runIdParameter: 6,
        threadIdParameter: 2,
      })}, persisted_shell AS (
        INSERT INTO ${this.tables.shellStates} (
        session_id,
        thread_id,
        execution_environment_id,
        cwd,
        env
      ) SELECT
        $1,
        active_run.thread_id,
        $3,
        $4,
        $5::jsonb
      FROM active_run
      ON CONFLICT (session_id, thread_id, execution_environment_id) DO UPDATE
      SET cwd = EXCLUDED.cwd,
          env = EXCLUDED.env,
          updated_at = NOW()
      RETURNING *
      )
      SELECT * FROM persisted_shell
    `, [
      input.sessionId,
      input.threadId,
      input.executionEnvironmentId,
      input.shellSession.cwd,
      toJson(input.shellSession.env),
      input.runId,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new ThreadRunClaimLostError(input.runId);
    }
    return this.parseShellStateRow(row);
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
        WHERE applied_at IS NULL
          AND discarded_at IS NULL
          AND thread_id IN (${placeholders})
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

  async updateThreadForRun(
    threadId: string,
    runId: string,
    update: ThreadRuntimeStateUpdate,
  ): Promise<ThreadRecord> {
    if (update.runtimeState === undefined) {
      const result = await this.pool.query(`
        WITH ${buildActiveThreadRunGuardCte(this.tables, {
          runIdParameter: 1,
          threadIdParameter: 2,
        })}
        SELECT thread.*
        FROM ${this.tables.threads} AS thread
        INNER JOIN active_run ON active_run.thread_id = thread.id
      `, [runId, threadId]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        throw new ThreadRunClaimLostError(runId);
      }
      return parseThreadRow(row);
    }

    const result = await this.pool.query(`
      WITH ${buildActiveThreadRunGuardCte(this.tables, {
        runIdParameter: 1,
        threadIdParameter: 2,
      })}, updated_thread AS (
        UPDATE ${this.tables.threads} AS thread
        SET runtime_state = $3::jsonb,
            updated_at = NOW()
        FROM active_run
        WHERE thread.id = active_run.thread_id
        RETURNING thread.*
      ), notified AS (
        SELECT pg_notify(
          $4,
          json_build_object('kind', 'thread_changed', 'threadId', updated_thread.id)::text
        ) AS notification
        FROM updated_thread
      )
      SELECT updated_thread.*, notified.notification
      FROM updated_thread
      INNER JOIN notified ON TRUE
    `, [runId, threadId, toJson(update.runtimeState ?? null), this.notificationChannel]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new ThreadRunClaimLostError(runId);
    }
    return parseThreadRow(row);
  }

  async loadActiveTranscript(threadId: string): Promise<ThreadTranscriptSnapshot> {
    const result = await this.pool.query(`
      WITH checkpoint AS (
        SELECT id, compacted_through_sequence
        FROM ${this.tables.messages}
        WHERE thread_id = $1
          AND compacted_through_sequence IS NOT NULL
        ORDER BY sequence DESC
        LIMIT 1
      ), active_records AS (
        SELECT message.*, checkpoint.id AS active_checkpoint_id, 0 AS replay_order
        FROM checkpoint
        INNER JOIN ${this.tables.messages} AS message ON message.id = checkpoint.id

        UNION ALL

        SELECT message.*, checkpoint.id AS active_checkpoint_id, 1 AS replay_order
        FROM ${this.tables.messages} AS message
        LEFT JOIN checkpoint ON TRUE
        WHERE message.thread_id = $1
          AND (
            message.source <> 'compact'
            OR COALESCE(message.metadata ->> 'kind', '') <> 'compact_failure_notice'
          )
          AND (
            checkpoint.id IS NULL
            OR (
              message.compacted_through_sequence IS NULL
              AND message.sequence > checkpoint.compacted_through_sequence
            )
          )
      )
      SELECT *
      FROM active_records
      ORDER BY replay_order ASC, sequence ASC
    `, [threadId]);

    const rows = result.rows.map((row) => row as Record<string, unknown>);
    const checkpointId = rows.find((row) => row.replay_order === 0)?.active_checkpoint_id;
    const records = rows.map(parseMessageRow);
    return {
      checkpointId: typeof checkpointId === "string" ? checkpointId : null,
      records: projectTranscriptForRun(records),
    };
  }

  async getMessage(messageId: string): Promise<ThreadMessageRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.messages} WHERE id = $1`,
      [messageId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseMessageRow(row) : null;
  }

  async listTranscriptPage(
    threadId: string,
    options: ThreadTranscriptPageOptions = {},
  ): Promise<ThreadTranscriptPage> {
    const limit = Math.max(
      1,
      Math.min(options.limit ?? DEFAULT_TRANSCRIPT_PAGE_SIZE, MAX_TRANSCRIPT_PAGE_SIZE),
    );
    const beforeSequence = options.beforeSequence;
    const afterSequence = options.afterSequence;
    if (beforeSequence !== undefined && afterSequence !== undefined) {
      throw new Error("Transcript pages cannot seek before and after a sequence at the same time.");
    }
    if (beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence <= 0)) {
      throw new Error("Transcript before cursor must be a positive safe integer.");
    }
    if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) {
      throw new Error("Transcript after cursor must be a non-negative safe integer.");
    }

    if (afterSequence !== undefined) {
      const result = await this.pool.query(`
        SELECT *
        FROM ${this.tables.messages}
        WHERE thread_id = $1
          AND sequence > $2
        ORDER BY sequence ASC
        LIMIT $3
      `, [threadId, afterSequence, limit + 1]);
      const ascending = result.rows.map((row) => parseMessageRow(row as Record<string, unknown>));
      const records = ascending.slice(0, limit);
      return {
        records,
        ...(ascending.length > limit && records.at(-1)
          ? {nextAfterSequence: records.at(-1)!.sequence}
          : {}),
      };
    }

    const result = beforeSequence === undefined
      ? await this.pool.query(`
        SELECT *
        FROM ${this.tables.messages}
        WHERE thread_id = $1
        ORDER BY sequence DESC
        LIMIT $2
      `, [threadId, limit + 1])
      : await this.pool.query(`
        SELECT *
        FROM ${this.tables.messages}
        WHERE thread_id = $1
          AND sequence < $2
        ORDER BY sequence DESC
        LIMIT $3
      `, [threadId, beforeSequence, limit + 1]);

    const descending = result.rows.map((row) => parseMessageRow(row as Record<string, unknown>));
    const records = descending.slice(0, limit).reverse();
    return {
      records,
      ...(descending.length > limit && records[0] ? {nextBeforeSequence: records[0].sequence} : {}),
    };
  }

  async commitCompaction(
    threadId: string,
    commit: ThreadCompactionCommit,
  ): Promise<ThreadMessageRecord> {
    if (!commit.runId) {
      throw new Error("Manual compaction must use commitCompactionExclusively().");
    }
    return this.commitCompactionRecord(threadId, commit);
  }

  async commitCompactionExclusively(
    threadId: string,
    commit: ThreadCompactionCommit,
    owner: ThreadRunOwner,
  ): Promise<ThreadMessageRecord> {
    if (commit.runId) {
      throw new Error("Run-owned compaction must use commitCompaction().");
    }
    return this.commitCompactionRecord(threadId, commit, owner);
  }

  private async commitCompactionRecord(
    threadId: string,
    commit: ThreadCompactionCommit,
    exclusiveOwner?: ThreadRunOwner,
  ): Promise<ThreadMessageRecord> {
    if (
      !Number.isSafeInteger(commit.metadata.compactedThroughSequence)
      || commit.metadata.compactedThroughSequence < 0
    ) {
      throw new Error("Compaction checkpoint sequence must be a non-negative safe integer.");
    }

    const {
      compactedThroughSequence,
      ...storedMetadata
    } = commit.metadata;
    const metadataJson = serializeThreadRuntimeJsonb(storedMetadata);
    const messageJson = serializeThreadRuntimeJsonb(commit.message);

    return withTransaction(this.pool, async (client) => {
      if (commit.runId) {
        // Run-owned writes always lock run before thread. Other run mutations
        // use that order too, so compaction cannot deadlock them while still
        // fencing an expired daemon before it appends a checkpoint.
        const activeRun = await client.query(`
          WITH ${buildActiveThreadRunGuardCte(this.tables, {
            runIdParameter: 1,
            threadIdParameter: 2,
          })}
          SELECT id FROM active_run
        `, [commit.runId, threadId]);
        if (activeRun.rows.length === 0) {
          throw new ThreadRunClaimLostError(commit.runId);
        }
      } else if (exclusiveOwner) {
        await assertExclusiveThreadAccess({
          queryable: client,
          tables: this.tables,
          threadId,
          owner: exclusiveOwner,
        });
      }

      const threadResult = await client.query(
        `SELECT id FROM ${this.tables.threads} WHERE id = $1 FOR UPDATE`,
        [threadId],
      );
      if (threadResult.rows.length === 0) {
        throw missingThreadError(threadId);
      }

      if (commit.id) {
        const replayResult = await client.query(
          `SELECT * FROM ${this.tables.messages} WHERE id = $1`,
          [commit.id],
        );
        if (replayResult.rows.length > 0) {
          const replay = parseMessageRow(replayResult.rows[0] as Record<string, unknown>);
          if (replay.threadId !== threadId || replay.source !== "compact") {
            throw new Error(`Compaction operation ${commit.id} conflicts with another message.`);
          }
          return replay;
        }
      }

      const checkpointResult = await client.query(`
        SELECT id
        FROM ${this.tables.messages}
        WHERE thread_id = $1
          AND compacted_through_sequence IS NOT NULL
        ORDER BY sequence DESC
        LIMIT 1
      `, [threadId]);
      const currentCheckpointId = (checkpointResult.rows[0] as {id?: unknown} | undefined)?.id;
      const normalizedCheckpointId = typeof currentCheckpointId === "string" ? currentCheckpointId : null;
      if (normalizedCheckpointId !== commit.expectedCheckpointId) {
        throw new StaleThreadCompactionError(threadId);
      }

      let result: PgQueryResult;
      try {
        result = await client.query(`
          INSERT INTO ${this.tables.messages} (
            id,
            thread_id,
            origin,
            source,
            run_id,
            run_thread_id,
            created_at,
            metadata,
            message,
            compacted_through_sequence
          ) VALUES (
            $1,
            $2,
            'runtime',
            'compact',
            $3,
            $4,
            $5,
            $6::jsonb,
            $7::jsonb,
            $8
          )
          RETURNING *
        `, [
          commit.id ?? randomUUID(),
          threadId,
          commit.runId ?? null,
          commit.runId ? threadId : null,
          new Date(commit.createdAt ?? Date.now()),
          metadataJson.json,
          messageJson.json,
          compactedThroughSequence,
        ]);
      } catch (error) {
        const jsonbError = createThreadRuntimeJsonbPersistenceError(error, {
          operation: "commitCompaction",
          table: this.tables.messages,
          fields: [
            {name: "metadata", nulCount: metadataJson.nulCount},
            {name: "message", nulCount: messageJson.nulCount},
          ],
        });
        throw jsonbError ?? error;
      }

      await this.touchThread(threadId, client);
      await this.notifyThreadChanged(threadId, client);
      return parseMessageRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async listChannelMessages(filter: ThreadChannelMessageFilter): Promise<readonly ThreadMessageRecord[]> {
    const limit = Math.max(0, Math.min(filter.limit ?? 50, 200));
    if (limit === 0) {
      return [];
    }

    const result = await this.pool.query(
      `
        SELECT message.*
        FROM ${this.tables.messages} AS message
        INNER JOIN ${this.tables.threads} AS thread
          ON thread.id = message.thread_id
        WHERE thread.session_id = $1
          AND message.source = $2
          AND message.channel_id = $3
          AND message.metadata -> 'route' ->> 'connectorKey' = $4
        ORDER BY message.created_at DESC, message.sequence DESC
        LIMIT $5
      `,
      [
        filter.sessionId,
        filter.source,
        filter.channelId,
        filter.connectorKey,
        limit,
      ],
    );

    return result.rows.map((row) => parseMessageRow(row as Record<string, unknown>));
  }

  async findChannelMedia(filter: ThreadChannelMediaFilter): Promise<ThreadChannelMediaRecord | null> {
    const result = await this.pool.query(
      `
        SELECT message.*
        FROM ${this.tables.messages} AS message
        INNER JOIN ${this.tables.threads} AS thread
          ON thread.id = message.thread_id
        WHERE thread.session_id = $1
          AND message.source = $2
          AND message.channel_id = $3
          AND message.metadata -> 'route' ->> 'connectorKey' = $4
        ORDER BY message.created_at DESC, message.sequence DESC
        LIMIT $5
      `,
      [
        filter.sessionId,
        filter.source,
        filter.channelId,
        filter.connectorKey,
        MAX_CHANNEL_MEDIA_SCAN_ROWS,
      ],
    );

    for (const row of result.rows) {
      const message = parseMessageRow(row as Record<string, unknown>);
      const media = readSourceMediaFromMessage(message, filter.source).find((descriptor) => {
        return descriptor.id === filter.mediaId
          && descriptor.source === filter.source
          && descriptor.connectorKey === filter.connectorKey;
      });
      if (media) {
        return {
          message,
          media,
        };
      }
    }

    return null;
  }

  async enqueueInput(
    threadId: string,
    payload: ThreadInputPayload,
    deliveryMode: ThreadInputDeliveryMode = "wake",
    options?: ThreadEnqueueOptions,
  ): Promise<ThreadEnqueueResult> {
    return enqueueThreadInput({
      pool: this.pool,
      tables: this.tables,
      sessionTable: this.sessionTables.sessions,
      sessionRuntimeConfigTable: this.sessionTables.sessionRuntimeConfig,
      notificationChannel: this.notificationChannel,
      threadId,
      payload,
      deliveryMode,
      enqueueOptions: options,
    });
  }

  async enqueueSessionInput(
    sessionId: string,
    payload: ThreadInputPayload,
    deliveryMode: ThreadInputDeliveryMode = "wake",
    options?: ThreadEnqueueOptions,
  ): Promise<ThreadEnqueueResult> {
    return enqueueSessionThreadInput({
      pool: this.pool,
      tables: this.tables,
      sessionTable: this.sessionTables.sessions,
      sessionRuntimeConfigTable: this.sessionTables.sessionRuntimeConfig,
      notificationChannel: this.notificationChannel,
      sessionId,
      payload,
      deliveryMode,
      enqueueOptions: options,
    });
  }

  async applyPendingInputs(
    threadId: string,
    runId: string,
  ): Promise<readonly ThreadMessageRecord[]> {
    return applyPendingThreadInputs({
      pool: this.pool,
      tables: this.tables,
      sessionRuntimeConfigTable: this.sessionTables.sessionRuntimeConfig,
      notificationChannel: this.notificationChannel,
      threadId,
      runId,
    });
  }

  async discardPendingInputsRecord(
    threadId: string,
    queryable: PgQueryable = this.pool,
  ): Promise<number> {
    return discardPendingThreadInputs({
      pool: queryable,
      tables: this.tables,
      notificationChannel: this.notificationChannel,
      threadId,
    });
  }

  async discardPendingInputs(threadId: string): Promise<number> {
    return this.discardPendingInputsRecord(threadId);
  }

  async assertExclusiveAccessRecord(
    threadId: string,
    owner: ThreadRunOwner,
    queryable: PgQueryable = this.pool,
  ): Promise<void> {
    await assertExclusiveThreadAccess({
      queryable,
      tables: this.tables,
      threadId,
      owner,
    });
  }

  /**
   * Locks the daemon fence before reset takes a session lock. Lease-first is
   * mandatory because a queued renewal can otherwise turn compatible shared
   * locks into a lease -> session -> lease deadlock cycle.
   */
  async lockOwnerRecord(
    owner: ThreadRunOwner,
    queryable: PgQueryable = this.pool,
  ): Promise<void> {
    await lockThreadRunOwner({queryable, owner});
  }

  async assertExclusiveAccessAfterOwnerLockRecord(
    threadId: string,
    owner: ThreadRunOwner,
    queryable: PgQueryable,
  ): Promise<void> {
    await assertExclusiveThreadAccess({
      queryable,
      tables: this.tables,
      threadId,
      owner,
      ownerLockHeld: true,
    });
  }

  async getInput(inputId: string): Promise<ThreadInputRecord> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.inputs}
      WHERE id = $1
    `, [inputId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown thread input ${inputId}`);
    }
    return parseInputRow(row);
  }

  async hasPendingInputs(threadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.tables.inputs}
       WHERE thread_id = $1 AND applied_at IS NULL AND discarded_at IS NULL LIMIT 1`,
      [threadId],
    );

    return result.rows.length > 0;
  }

  async hasRunnableInputs(threadId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM ${this.tables.inputs}
       WHERE thread_id = $1 AND applied_at IS NULL AND discarded_at IS NULL AND delivery_mode = 'wake'
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

  async isThreadRunnable(threadId: string): Promise<boolean> {
    return isRunnableThread({
      queryable: this.pool,
      tables: this.tables,
      sessionTables: this.sessionTables,
      threadId,
    });
  }

  async promoteQueuedInputs(threadId?: string): Promise<readonly string[]> {
    return promoteQueuedThreadInputs({
      pool: this.pool,
      tables: this.tables,
      sessionTable: this.sessionTables.sessions,
      sessionRuntimeConfigTable: this.sessionTables.sessionRuntimeConfig,
      notificationChannel: this.notificationChannel,
      threadId,
    });
  }

  async requestWake(threadId: string): Promise<void> {
    const result = await this.pool.query(`
      WITH target_session AS (
        SELECT thread.session_id
        FROM ${this.tables.threads} AS thread
        WHERE thread.id = $1
      ), locked_session AS (
        SELECT session.id, session.current_thread_id
        FROM ${this.sessionTables.sessions} AS session
        WHERE session.id = (SELECT session_id FROM target_session)
          AND session.current_thread_id = $1
        FOR UPDATE
      ), target AS (
        SELECT thread.id, thread.session_id
        FROM ${this.tables.threads} AS thread
        WHERE thread.id = $1
          AND thread.session_id = (SELECT id FROM locked_session)
          AND thread.id = (SELECT current_thread_id FROM locked_session)
        FOR UPDATE
      ), wake AS (
        INSERT INTO ${this.sessionTables.sessionRuntimeConfig} (
          session_id,
          pending_wake_at,
          pending_wake_generation
        )
        SELECT target.session_id, NOW(), 1
        FROM target
        ON CONFLICT (session_id) DO UPDATE
        SET pending_wake_at = COALESCE(${this.sessionTables.sessionRuntimeConfig}.pending_wake_at, NOW()),
            pending_wake_generation = ${this.sessionTables.sessionRuntimeConfig}.pending_wake_generation + 1,
            updated_at = NOW()
        RETURNING session_id
      ), notified AS (
        SELECT pg_notify(
          $2,
          json_build_object('kind', 'thread_runnable', 'threadId', target.id)::text
        ) AS notification
        FROM target
        INNER JOIN wake ON wake.session_id = target.session_id
      )
      SELECT target.id, notified.notification
      FROM target
      INNER JOIN notified ON TRUE
    `, [threadId, this.notificationChannel]);
    if (result.rows.length === 0) {
      throw missingThreadError(threadId);
    }
  }

  async appendRuntimeMessage(
    threadId: string,
    payload: ThreadRuntimeMessagePayload,
  ): Promise<ThreadMessageRecord> {
    if (hasCompactBoundaryKind(payload.metadata)) {
      throw new Error("Compact boundaries must be persisted with commitCompaction().");
    }
    const createdAt = new Date(payload.createdAt ?? Date.now());
    const metadataJson = serializeThreadRuntimeJsonb(payload.metadata);
    const messageJson = serializeThreadRuntimeJsonb(payload.message);
    const activeRunCte = payload.runId
      ? buildActiveThreadRunGuardCte(this.tables, {runIdParameter: 9, threadIdParameter: 2})
      : "active_run AS (SELECT $2::text AS thread_id)";
    let result: PgQueryResult;
    try {
      result = await this.pool.query(`
        WITH ${activeRunCte}, inserted AS (
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
          )
          SELECT
            $1,
            active_run.thread_id,
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
          FROM active_run
          RETURNING *
        ), updated_thread AS (
          UPDATE ${this.tables.threads} AS thread
          SET updated_at = NOW()
          FROM inserted
          WHERE thread.id = inserted.thread_id
          RETURNING thread.id
        ), notified AS (
          SELECT pg_notify(
            $14,
            json_build_object('kind', 'thread_changed', 'threadId', updated_thread.id)::text
          ) AS notification
          FROM updated_thread
        )
        SELECT inserted.*, notified.notification
        FROM inserted
        INNER JOIN notified ON TRUE
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
        this.notificationChannel,
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

    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      if (payload.runId) {
        throw new ThreadRunClaimLostError(payload.runId);
      }
      throw missingThreadError(threadId);
    }
    return parseMessageRow(row);
  }

  async tryStartRun(threadId: string, owner: ThreadRunOwner): Promise<ThreadRunRecord | null> {
    const record = await tryStartThreadRun({
      queryable: this.pool,
      tables: this.tables,
      sessionTables: this.sessionTables,
      threadId,
      owner,
      notificationChannel: this.notificationChannel,
    });
    return record;
  }

  async assertRunActive(runId: string): Promise<void> {
    if (!await isThreadRunActive({queryable: this.pool, tables: this.tables, runId})) {
      throw new ThreadRunClaimLostError(runId);
    }
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

  async listAbortRequestedRuns(runIds: readonly string[]): Promise<readonly ThreadRunRecord[]> {
    if (runIds.length === 0) {
      return [];
    }

    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.runs}
      WHERE id = ANY($1::uuid[])
        AND abort_requested_at IS NOT NULL
      ORDER BY started_at ASC
    `, [runIds]);

    return result.rows.map((row) => parseRunRow(row as Record<string, unknown>));
  }

  async completeRun(runId: string): Promise<ThreadRunRecord> {
    return withTransaction(this.pool, async (client) => {
      const record = await completeOwnedThreadRun({
        queryable: client,
        tables: this.tables,
        runId,
      });
      await this.notifyThreadChanged(record.threadId, client);
      return record;
    });
  }

  async failRun(runId: string, error?: string): Promise<ThreadRunRecord> {
    return withTransaction(this.pool, async (client) => {
      const record = await failOwnedThreadRun({
        queryable: client,
        tables: this.tables,
        sessionTables: this.sessionTables,
        runId,
        ...(error !== undefined ? {error} : {}),
        notificationChannel: this.notificationChannel,
      });
      await this.notifyThreadChanged(record.threadId, client);
      return record;
    });
  }

  async failOrphanedRuns(
    owner: ThreadRunOwner,
    error: string,
    limit: number,
  ): Promise<readonly ThreadRunRecord[]> {
    return withTransaction(this.pool, async (client) => {
      const records = await failOrphanedThreadRuns({
        queryable: client,
        tables: this.tables,
        sessionTables: this.sessionTables,
        owner,
        error,
        limit,
        notificationChannel: this.notificationChannel,
      });
      for (const record of records) {
        await this.notifyThreadChanged(record.threadId, client);
      }
      return records;
    });
  }

  async listRunnableThreadIds(limit: number): Promise<readonly string[]> {
    return loadRunnableThreadIds({
      queryable: this.pool,
      tables: this.tables,
      sessionTables: this.sessionTables,
      limit,
    });
  }

  async takeRunBoundary(
    threadId: string,
    runId: string,
  ): Promise<{hasRunnableInputs: boolean; hasAdmittedInputs: boolean; hadPendingWake: boolean}> {
    return takeOwnedThreadRunBoundary({
      queryable: this.pool,
      tables: this.tables,
      sessionTables: this.sessionTables,
      threadId,
      runId,
    });
  }

  async listRuns(threadId: string): Promise<readonly ThreadRunRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.runs} WHERE thread_id = $1 ORDER BY started_at ASC`,
      [threadId],
    );

    return result.rows.map((row) => parseRunRow(row as Record<string, unknown>));
  }

  async getLatestRun(threadId: string): Promise<ThreadRunRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.runs}
       WHERE thread_id = $1
       ORDER BY started_at DESC
       LIMIT 1`,
      [threadId],
    );
    const row = result.rows[0];
    return row ? parseRunRow(row as Record<string, unknown>) : null;
  }

  async createToolJob(input: CreateThreadToolJobInput): Promise<ThreadToolJobRecord> {
    if (!input.runId && !input.owner) {
      throw new Error("A standalone background tool job requires the current daemon owner.");
    }
    const startedAt = input.startedAt ?? Date.now();
    const insert = async (
      queryable: PgQueryable,
      commandOrdinal: number | null,
    ): Promise<PgQueryResult> => {
      const runGuard = input.runId
        ? buildActiveThreadRunGuardCte(this.tables, {runIdParameter: 3, threadIdParameter: 2})
        : `current_owner AS MATERIALIZED (
            SELECT source, connector_key, holder_id
            FROM ${POSTGRES_CONNECTOR_LEASE_TABLE}
            WHERE source = $15
              AND connector_key = $16
              AND holder_id = $17
              AND leased_until > NOW()
            FOR SHARE
          ), active_run AS (
            SELECT
              $2::text AS thread_id,
              current_owner.source AS owner_source,
              current_owner.connector_key AS owner_key,
              current_owner.holder_id AS owner_holder_id
            FROM current_owner
            WHERE EXISTS (SELECT 1 FROM ${this.tables.threads} AS thread WHERE thread.id = $2)
          )`;
      const notificationParameter = input.runId ? 15 : 18;
      return queryable.query(`
      WITH ${runGuard}, inserted AS (
        INSERT INTO ${this.tables.toolJobs} (
        id,
        thread_id,
        run_id,
        run_thread_id,
        owner_source,
        owner_key,
        owner_holder_id,
        parent_tool_call_id,
        command_ordinal,
        kind,
        status,
        summary,
        started_at,
        result,
        error,
        status_reason,
        progress
      ) SELECT
        $1,
        active_run.thread_id,
        $3,
        $4,
        active_run.owner_source,
        active_run.owner_key,
        active_run.owner_holder_id,
        $5,
        $6,
        $7,
        $8,
        $9,
        $10,
        $11::jsonb,
        $12,
        $13,
        $14::jsonb
      FROM active_run
      RETURNING *
      ), updated_thread AS (
        UPDATE ${this.tables.threads} AS thread
        SET updated_at = NOW()
        FROM inserted
        WHERE thread.id = inserted.thread_id
        RETURNING thread.id
      ), notified AS (
        SELECT pg_notify(
          $${notificationParameter},
          json_build_object('kind', 'thread_changed', 'threadId', updated_thread.id)::text
        ) AS notification
        FROM updated_thread
      )
      SELECT inserted.*, notified.notification
      FROM inserted
      INNER JOIN notified ON TRUE
    `, [
      input.id,
      input.threadId,
      input.runId ?? null,
      input.runId ? input.threadId : null,
      input.parentToolCallId ?? null,
      commandOrdinal,
      input.kind,
      input.status ?? "running",
      input.summary ?? "",
      new Date(startedAt),
      toJson(input.result),
      input.error ?? null,
      input.statusReason ?? null,
      toJson(input.progress),
      ...(input.runId
        ? []
        : [input.owner!.source, input.owner!.connectorKey, input.owner!.holderId]),
      this.notificationChannel,
    ]);
    };

    const result = input.parentToolCallId
      ? await withTransaction(this.pool, async (client) => {
        if (!input.runId) {
          throw new Error("A parent Panda tool call requires its originating run id.");
        }

        const lockedRun = await client.query(`
          WITH ${buildActiveThreadRunGuardCte(this.tables, {
            runIdParameter: 1,
            threadIdParameter: 2,
          })}
          SELECT id FROM active_run
        `, [input.runId, input.threadId]);
        if (!lockedRun.rows[0]) {
          throw new ThreadRunClaimLostError(input.runId);
        }

        const ordinalResult = await client.query(`
          SELECT COALESCE(MAX(command_ordinal), 0) + 1 AS command_ordinal
          FROM ${this.tables.toolJobs}
          WHERE thread_id = $1
            AND run_id = $2
            AND parent_tool_call_id = $3
        `, [input.threadId, input.runId, input.parentToolCallId]);
        const commandOrdinal = Number((ordinalResult.rows[0] as {command_ordinal?: unknown} | undefined)?.command_ordinal);
        if (!Number.isSafeInteger(commandOrdinal) || commandOrdinal < 1) {
          throw new Error("Could not assign a Panda command execution ordinal.");
        }

        return insert(client, commandOrdinal);
      })
      : await insert(this.pool, null);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      if (input.runId) {
        throw new ThreadRunClaimLostError(input.runId);
      }
      await this.getThread(input.threadId);
      throw new ThreadToolJobOwnershipLostError(input.id);
    }
    return parseToolJobRow(row);
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

  async listCommandToolJobsByParent(
    threadId: string,
    runId: string,
    parentToolCallId: string,
  ): Promise<readonly ThreadToolJobRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.toolJobs}
      WHERE thread_id = $1
        AND run_id = $2
        AND parent_tool_call_id = $3
        AND kind = 'command'
      ORDER BY command_ordinal ASC
    `, [threadId, runId, parentToolCallId]);

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

    const notificationParameter = index;
    values.push(this.notificationChannel);
    const result = await this.pool.query(`
      WITH ${buildOwnedToolJobGuardCte(this.tables, {jobIdParameter: 1})}, updated_job AS (
        UPDATE ${this.tables.toolJobs} AS job
        SET ${assignments.join(", ")}
        FROM owned_job
        WHERE job.id = owned_job.id
        RETURNING job.*
      ), updated_thread AS (
        UPDATE ${this.tables.threads} AS thread
        SET updated_at = NOW()
        FROM updated_job
        WHERE thread.id = updated_job.thread_id
        RETURNING thread.id
      ), notified AS (
        SELECT pg_notify(
          $${notificationParameter},
          json_build_object('kind', 'thread_changed', 'threadId', updated_thread.id)::text
        ) AS notification
        FROM updated_thread
      )
      SELECT updated_job.*, notified.notification
      FROM updated_job
      INNER JOIN notified ON TRUE
    `, values);

    const row = result.rows[0];
    if (!row) {
      const existing = await this.getToolJob(jobId);
      if (existing.status !== "running") {
        return existing;
      }
      throw new ThreadToolJobOwnershipLostError(existing.id);
    }

    return parseToolJobRow(row as Record<string, unknown>);
  }

  async markOrphanedToolJobsLost(
    owner: ThreadRunOwner,
    reason: string,
    limit: number,
  ): Promise<number> {
    return markOrphanedThreadToolJobsLost({
      queryable: this.pool,
      tables: this.tables,
      owner,
      error: reason,
      limit,
      notificationChannel: this.notificationChannel,
    });
  }

  async listPendingInputs(threadId: string): Promise<readonly ThreadPendingInputRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.inputs}
      WHERE thread_id = $1 AND applied_at IS NULL AND discarded_at IS NULL
      ORDER BY input_order ASC
    `, [threadId]);

    return result.rows.map((row) => parsePendingInputRow(row as Record<string, unknown>));
  }

  async requestRunAbort(
    threadId: string,
    reason = "Aborted by runtime request.",
    operationId = randomUUID(),
  ): Promise<ThreadRunRecord | null> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.pool.query(`
      WITH existing_operation AS MATERIALIZED (
        SELECT operation.*
        FROM ${this.tables.abortOperations} AS operation
        WHERE operation.operation_id = $3
      ), target_run AS MATERIALIZED (
        -- Active-run mutations lock run -> thread. Abort must use the same
        -- order or a boundary/failure racing an abort can deadlock.
        SELECT run.id, run.thread_id
        FROM ${this.tables.runs} AS run
        WHERE run.thread_id = $1
          AND run.status = 'running'
          AND NOT EXISTS (SELECT 1 FROM existing_operation)
        ORDER BY run.started_at DESC
        LIMIT 1
        FOR UPDATE OF run
      ), target_thread AS MATERIALIZED (
        -- This is deliberately not a row lock. A statement-snapshot no-run
        -- receipt linearizes before any concurrent, still-invisible run claim;
        -- the receipt foreign key protects the thread without inverting the
        -- run -> thread lock order used by active-run mutations.
        SELECT thread.id, target_run.id AS run_id
        FROM ${this.tables.threads} AS thread
        LEFT JOIN target_run ON TRUE
        WHERE thread.id = $1
      ), inserted_operation AS (
        INSERT INTO ${this.tables.abortOperations} (
          operation_id,
          thread_id,
          run_id,
          reason
        )
        SELECT $3, target_thread.id, target_thread.run_id, $2
        FROM target_thread
        WHERE NOT EXISTS (SELECT 1 FROM existing_operation)
        ON CONFLICT (operation_id) DO NOTHING
        RETURNING *
      ), operation AS MATERIALIZED (
        SELECT * FROM inserted_operation
        UNION ALL
        SELECT * FROM existing_operation
      ), aborted AS (
        UPDATE ${this.tables.runs} AS run
        SET abort_requested_at = COALESCE(run.abort_requested_at, NOW()),
            abort_reason = COALESCE(run.abort_reason, inserted_operation.reason)
        FROM inserted_operation
        WHERE inserted_operation.thread_id = $1
          AND inserted_operation.reason = $2
          AND run.id = inserted_operation.run_id
          AND run.thread_id = inserted_operation.thread_id
        RETURNING run.*
      ), resolved_run AS (
        SELECT * FROM aborted
        UNION ALL
        SELECT run.*
        FROM ${this.tables.runs} AS run
        INNER JOIN existing_operation
          ON existing_operation.run_id = run.id
         AND existing_operation.thread_id = run.thread_id
        WHERE NOT EXISTS (SELECT 1 FROM aborted)
      ), notified AS (
        SELECT pg_notify(
          $4,
          json_build_object(
            'kind', 'run_abort_requested',
            'threadId', aborted.thread_id,
            'runId', aborted.id
          )::text
        ) AS notification
        FROM aborted
      )
      SELECT
        EXISTS (SELECT 1 FROM target_thread) AS thread_found,
        EXISTS (SELECT 1 FROM operation) AS operation_found,
        (SELECT thread_id FROM operation) AS operation_thread_id,
        (SELECT reason FROM operation) AS operation_reason,
        (SELECT run_id FROM operation) AS operation_run_id,
        resolved_run.*,
        (SELECT COUNT(*) FROM notified) AS notification_count
      FROM (VALUES (1)) AS singleton(value)
      LEFT JOIN resolved_run ON TRUE
      `, [threadId, reason, operationId, this.notificationChannel]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row || row.thread_found !== true) {
        throw missingThreadError(threadId);
      }
      if (row.operation_found !== true) {
        // A concurrent caller can win the same operation-id insert after this
        // statement's snapshot. Retry once to read its committed receipt.
        if (attempt === 0) continue;
        throw new Error(`Abort operation ${operationId} could not be resolved after a concurrent insert.`);
      }
      if (row.operation_thread_id !== threadId || row.operation_reason !== reason) {
        throw new Error(`Abort operation ${operationId} conflicts with another request.`);
      }
      if (row.operation_run_id === null) {
        return null;
      }
      return parseRunRow(row);
    }
    throw new Error(`Abort operation ${operationId} could not be resolved.`);
  }
}
