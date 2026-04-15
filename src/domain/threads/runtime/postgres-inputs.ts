import {randomUUID} from "node:crypto";

import type {ThreadEnqueueResult} from "./store.js";
import {type ThreadRuntimeTableNames, toJson} from "./postgres-shared.js";
import {parseInputRow, parseMessageRow} from "./postgres-rows.js";
import {type PgPoolLike, type PgQueryable, withTransaction} from "./postgres-db.js";
import type {ThreadInputDeliveryMode, ThreadInputPayload, ThreadMessageRecord,} from "./types.js";

interface ThreadMutationCallbacks {
  touchThread(threadId: string, queryable?: PgQueryable): Promise<void>;
  notifyThreadChanged(threadId: string, queryable?: PgQueryable): Promise<void>;
}

interface ThreadInputMutationOptions extends ThreadMutationCallbacks {
  pool: PgQueryable;
  tables: ThreadRuntimeTableNames;
  threadId: string;
}

export async function enqueueThreadInput(
  options: ThreadInputMutationOptions & {
    payload: ThreadInputPayload;
    deliveryMode: ThreadInputDeliveryMode;
  },
): Promise<ThreadEnqueueResult> {
  const { pool, tables, threadId, payload, deliveryMode } = options;

  if (payload.externalMessageId) {
    const existingResult = await pool.query(`
      SELECT *
      FROM ${tables.inputs}
      WHERE thread_id = $1
        AND source = $2
        AND (($3::text IS NULL AND channel_id IS NULL) OR channel_id = $3::text)
        AND external_message_id = $4
      ORDER BY input_order DESC
      LIMIT 1
    `, [
      threadId,
      payload.source,
      payload.channelId ?? null,
      payload.externalMessageId,
    ]);

    const existingRow = existingResult.rows[0] as Record<string, unknown> | undefined;
    if (existingRow) {
      let record = parseInputRow(existingRow);
      let promoted = false;

      if (!record.appliedAt && record.deliveryMode === "queue" && deliveryMode === "wake") {
        const promotedResult = await pool.query(`
          UPDATE ${tables.inputs}
          SET delivery_mode = 'wake'
          WHERE id = $1
          RETURNING *
        `, [record.id]);

        record = parseInputRow(promotedResult.rows[0] as Record<string, unknown>);
        promoted = true;
      }

      if (promoted) {
        await options.touchThread(threadId, pool);
        await options.notifyThreadChanged(threadId, pool);
      }

      return {
        input: record,
        inserted: false,
      };
    }
  }

  const id = randomUUID();
  const createdAt = new Date();

  try {
    const insertResult = await pool.query(`
      INSERT INTO ${tables.inputs} (
        id,
        thread_id,
        delivery_mode,
        source,
        channel_id,
        external_message_id,
        actor_id,
        identity_id,
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
        $10::jsonb,
        $11::jsonb
      )
      RETURNING *
    `, [
      id,
      threadId,
      deliveryMode,
      payload.source,
      payload.channelId ?? null,
      payload.externalMessageId ?? null,
      payload.actorId ?? null,
      payload.identityId ?? null,
      createdAt,
      toJson(payload.metadata),
      toJson(payload.message),
    ]);

    await options.touchThread(threadId, pool);

    const record = parseInputRow(insertResult.rows[0] as Record<string, unknown>);
    await options.notifyThreadChanged(threadId, pool);
    return {
      input: record,
      inserted: true,
    };
  } catch (error) {
    const duplicateKey = error as { code?: string };
    if (duplicateKey.code === "23505" && payload.externalMessageId) {
      return enqueueThreadInput(options);
    }

    throw error;
  }
}

export async function applyPendingThreadInputs(
  options: ThreadInputMutationOptions & { pool: PgPoolLike },
): Promise<readonly ThreadMessageRecord[]> {
  return withTransaction(options.pool, async (client) => {
    const pendingResult = await client.query(`
      SELECT *
      FROM ${options.tables.inputs}
      WHERE thread_id = $1 AND applied_at IS NULL
      ORDER BY input_order ASC
      FOR UPDATE
    `, [options.threadId]);

    if (pendingResult.rows.length === 0) {
      return [];
    }

    await options.touchThread(options.threadId, client);

    const pendingRows = pendingResult.rows.map((row) => row as Record<string, unknown>);
    const inserted: ThreadMessageRecord[] = [];

    for (const row of pendingRows) {
      await client.query(
        `UPDATE ${options.tables.inputs} SET applied_at = NOW() WHERE id = $1`,
        [String(row.id)],
      );

      const insertResult = await client.query(`
        INSERT INTO ${options.tables.messages} (
          id,
          thread_id,
          origin,
          source,
          channel_id,
          external_message_id,
          actor_id,
          identity_id,
          created_at,
          metadata,
          message
        ) VALUES (
          $1,
          $2,
          'input',
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
        options.threadId,
        row.source,
        row.channel_id ?? null,
        row.external_message_id ?? null,
        row.actor_id ?? null,
        row.identity_id ?? null,
        row.created_at,
        toJson(row.metadata ?? null),
        toJson(row.message),
      ]);

      inserted.push(parseMessageRow(insertResult.rows[0] as Record<string, unknown>));
    }

    await options.notifyThreadChanged(options.threadId, client);
    return inserted;
  });
}

export async function discardPendingThreadInputs(
  options: ThreadInputMutationOptions & { pool: PgPoolLike },
): Promise<number> {
  return withTransaction(options.pool, async (client) => {
    const deletedResult = await client.query(`
      DELETE FROM ${options.tables.inputs}
      WHERE thread_id = $1 AND applied_at IS NULL
      RETURNING id
    `, [options.threadId]);

    const deletedCount = deletedResult.rowCount ?? 0;
    if (deletedCount === 0) {
      return 0;
    }

    await options.touchThread(options.threadId, client);
    await options.notifyThreadChanged(options.threadId, client);
    return deletedCount;
  });
}

export async function promoteQueuedThreadInputs(
  options: ThreadMutationCallbacks & {
    pool: PgQueryable;
    tables: ThreadRuntimeTableNames;
    threadId?: string;
  },
): Promise<readonly string[]> {
  const values: unknown[] = [];
  let whereClause = "applied_at IS NULL AND delivery_mode = 'queue'";

  if (options.threadId) {
    values.push(options.threadId);
    whereClause += " AND thread_id = $1";
  }

  const result = await options.pool.query(`
    UPDATE ${options.tables.inputs}
    SET delivery_mode = 'wake'
    WHERE ${whereClause}
    RETURNING thread_id
  `, values);

  const promotedThreadIds = [...new Set(result.rows.map((row) => String((row as Record<string, unknown>).thread_id)))];
  await Promise.all(promotedThreadIds.map((threadId) => options.notifyThreadChanged(threadId, options.pool)));
  return promotedThreadIds;
}
