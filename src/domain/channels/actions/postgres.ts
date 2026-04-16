import {randomUUID} from "node:crypto";

import type {Pool, PoolClient} from "pg";

import {quoteIdentifier, toMillis} from "../../threads/runtime/postgres-shared.js";
import {
    buildActionNotificationChannel,
    buildChannelActionTableNames,
    type ChannelActionTableNames,
} from "./postgres-shared.js";
import type {ActionNotification, ActionWorkerLookup, ChannelActionInput, ChannelActionRecord,} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface PostgresChannelActionStoreOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
}

function requireTrimmed(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Channel action ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeLookup(lookup: ActionWorkerLookup): ActionWorkerLookup {
  return {
    channel: requireTrimmed("channel", lookup.channel),
    connectorKey: requireTrimmed("connector key", lookup.connectorKey),
  };
}

function parseNotification(payload: string): ActionNotification | null {
  try {
    const parsed = JSON.parse(payload) as Partial<ActionNotification>;
    if (!parsed || typeof parsed.channel !== "string" || typeof parsed.connectorKey !== "string") {
      return null;
    }

    return {
      channel: parsed.channel,
      connectorKey: parsed.connectorKey,
    };
  } catch {
    return null;
  }
}

function parseRecord(row: Record<string, unknown>): ChannelActionRecord {
  return {
    id: String(row.id),
    channel: String(row.channel),
    connectorKey: String(row.connector_key),
    kind: String(row.kind) as ChannelActionRecord["kind"],
    payload: row.payload as ChannelActionRecord["payload"],
    status: String(row.status) as ChannelActionRecord["status"],
    attemptCount: Number(row.attempt_count),
    lastError: typeof row.last_error === "string" ? row.last_error : undefined,
    claimedAt: row.claimed_at === null ? undefined : toMillis(row.claimed_at),
    completedAt: row.completed_at === null ? undefined : toMillis(row.completed_at),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function buildClaimNextPendingActionQuery(tableName: string, useSkipLocked: boolean): string {
  return `
    SELECT *
    FROM ${tableName}
    WHERE channel = $1
      AND connector_key = $2
      AND status = 'pending'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
    FOR UPDATE${useSkipLocked ? " SKIP LOCKED" : ""}
  `;
}

function isSkipLockedSyntaxUnsupported(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("skip locked")
    || message.includes("kw_skip")
    || message.includes("syntax error");
}

export class PostgresChannelActionStore {
  private readonly pool: PgPoolLike;
  private readonly tables: ChannelActionTableNames;
  private readonly notificationChannel: string;

  constructor(options: PostgresChannelActionStoreOptions) {
    this.pool = options.pool;
    const prefix = options.tablePrefix ?? "thread_runtime";
    this.tables = buildChannelActionTableNames(prefix);
    this.notificationChannel = buildActionNotificationChannel(prefix);
  }

  private async notify(input: ActionNotification): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [
      this.notificationChannel,
      JSON.stringify(input),
    ]);
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.channelActions} (
        id UUID PRIMARY KEY,
        channel TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload JSONB NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claimed_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_channel_actions_pending_idx`)}
      ON ${this.tables.channelActions} (channel, connector_key, status, created_at, id)
    `);
  }

  async enqueueAction(input: ChannelActionInput): Promise<ChannelActionRecord> {
    const channel = requireTrimmed("channel", input.channel);
    const connectorKey = requireTrimmed("connector key", input.connectorKey);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.channelActions} (
        id,
        channel,
        connector_key,
        kind,
        payload,
        status
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb,
        'pending'
      )
      RETURNING *
    `, [
      randomUUID(),
      channel,
      connectorKey,
      input.kind,
      JSON.stringify(input.payload),
    ]);
    const record = parseRecord(result.rows[0] as Record<string, unknown>);
    await this.notify({
      channel: record.channel,
      connectorKey: record.connectorKey,
    });
    return record;
  }

  async claimNextPendingAction(lookup: ActionWorkerLookup): Promise<ChannelActionRecord | null> {
    const normalized = normalizeLookup(lookup);
    const client = await this.pool.connect();

    try {
      // Real Postgres should skip already-locked rows so overlapping workers do not
      // stall on the same oldest pending action. pg-mem does not parse SKIP LOCKED,
      // so tests fall back to plain FOR UPDATE.
      for (const useSkipLocked of [true, false] as const) {
        let inTransaction = false;
        try {
          await client.query("BEGIN");
          inTransaction = true;

          const selectResult = await client.query(
            buildClaimNextPendingActionQuery(this.tables.channelActions, useSkipLocked),
            [
              normalized.channel,
              normalized.connectorKey,
            ],
          );
          const row = selectResult.rows[0];
          if (!row) {
            await client.query("COMMIT");
            return null;
          }

          const updateResult = await client.query(`
            UPDATE ${this.tables.channelActions}
            SET status = 'sending',
                attempt_count = attempt_count + 1,
                claimed_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            RETURNING *
          `, [
            String((row as Record<string, unknown>).id),
          ]);

          await client.query("COMMIT");
          const updatedRow = updateResult.rows[0];
          return updatedRow ? parseRecord(updatedRow as Record<string, unknown>) : null;
        } catch (error) {
          if (inTransaction) {
            await client.query("ROLLBACK");
          }

          if (useSkipLocked && isSkipLockedSyntaxUnsupported(error)) {
            continue;
          }

          throw error;
        }
      }

      return null;
    } finally {
      client.release();
    }
  }

  async markActionSent(id: string): Promise<ChannelActionRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = 'sent',
          completed_at = NOW(),
          updated_at = NOW(),
          last_error = NULL
      WHERE id = $1
      RETURNING *
    `, [requireTrimmed("id", id)]);
    return parseRecord(result.rows[0] as Record<string, unknown>);
  }

  async markActionFailed(id: string, error: string): Promise<ChannelActionRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = 'failed',
          completed_at = NOW(),
          updated_at = NOW(),
          last_error = $2
      WHERE id = $1
      RETURNING *
    `, [
      requireTrimmed("id", id),
      error,
    ]);
    return parseRecord(result.rows[0] as Record<string, unknown>);
  }

  async failSendingActions(lookup: ActionWorkerLookup, error: string): Promise<number> {
    const normalized = normalizeLookup(lookup);
    const result = await this.pool.query(`
      UPDATE ${this.tables.channelActions}
      SET status = 'failed',
          completed_at = NOW(),
          updated_at = NOW(),
          last_error = $3
      WHERE channel = $1
        AND connector_key = $2
        AND status = 'sending'
    `, [
      normalized.channel,
      normalized.connectorKey,
      error,
    ]);
    return result.rowCount ?? 0;
  }

  async listenPendingActions(
    listener: (notification: ActionNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    const handleNotification = (message: { channel: string; payload?: string }) => {
      if (message.channel !== this.notificationChannel || typeof message.payload !== "string") {
        return;
      }

      const parsed = parseNotification(message.payload);
      if (!parsed) {
        return;
      }

      void listener(parsed);
    };

    client.on("notification", handleNotification);
    await client.query(`LISTEN ${this.notificationChannel}`);

    return async () => {
      client.off("notification", handleNotification);
      try {
        await client.query(`UNLISTEN ${this.notificationChannel}`);
      } finally {
        client.release();
      }
    };
  }
}
