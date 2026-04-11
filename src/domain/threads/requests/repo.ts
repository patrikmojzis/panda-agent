import {randomUUID} from "node:crypto";

import type {Pool, PoolClient} from "pg";

import {toJson, toMillis} from "../runtime/postgres-shared.js";
import {
  buildPandaRuntimeRequestNotificationChannel,
  buildPandaRuntimeRequestTableNames,
  type PandaRuntimeRequestTableNames,
} from "./postgres-shared.js";
import type {CreateRuntimeRequestInput, PandaRuntimeRequestPayload, PandaRuntimeRequestRecord,} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface PandaRuntimeRequestRepoOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
}

function parseRecord<TPayload extends PandaRuntimeRequestPayload>(
  row: Record<string, unknown>,
): PandaRuntimeRequestRecord<TPayload> {
  return {
    id: String(row.id),
    kind: String(row.kind) as PandaRuntimeRequestRecord["kind"],
    status: String(row.status) as PandaRuntimeRequestRecord["status"],
    payload: row.payload as TPayload,
    result: row.result === null ? undefined : row.result as PandaRuntimeRequestRecord["result"],
    error: typeof row.error === "string" ? row.error : undefined,
    claimedAt: row.claimed_at === null ? undefined : toMillis(row.claimed_at),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
    finishedAt: row.finished_at === null ? undefined : toMillis(row.finished_at),
  };
}

function requireTrimmedRequestId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("Runtime request id must not be empty.");
  }

  return trimmed;
}

export class PandaRuntimeRequestRepo {
  private readonly pool: PgPoolLike;
  private readonly tables: PandaRuntimeRequestTableNames;
  private readonly notificationChannel: string;

  constructor(options: PandaRuntimeRequestRepoOptions) {
    this.pool = options.pool;
    const prefix = options.tablePrefix ?? "thread_runtime";
    this.tables = buildPandaRuntimeRequestTableNames(prefix);
    this.notificationChannel = buildPandaRuntimeRequestNotificationChannel(prefix);
  }

  private async notifyPendingRequest(): Promise<void> {
    await this.pool.query("SELECT pg_notify($1, $2)", [this.notificationChannel, "pending"]);
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.runtimeRequests} (
        id UUID PRIMARY KEY,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        payload JSONB NOT NULL,
        result JSONB,
        error TEXT,
        claimed_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS "${this.tables.prefix}_runtime_requests_pending_idx"
      ON ${this.tables.runtimeRequests} (status, created_at, id)
    `);
  }

  async enqueueRequest<TPayload extends PandaRuntimeRequestPayload>(
    input: CreateRuntimeRequestInput<TPayload>,
  ): Promise<PandaRuntimeRequestRecord<TPayload>> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.runtimeRequests} (
        id,
        kind,
        status,
        payload
      ) VALUES (
        $1,
        $2,
        'pending',
        $3::jsonb
      )
      RETURNING *
    `, [
      randomUUID(),
      input.kind,
      JSON.stringify(input.payload),
    ]);

    const record = parseRecord<TPayload>(result.rows[0] as Record<string, unknown>);
    await this.notifyPendingRequest();
    return record;
  }

  async claimNextPendingRequest(): Promise<PandaRuntimeRequestRecord | null> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const claimed = await client.query(`
        WITH next_request AS (
          SELECT id
          FROM ${this.tables.runtimeRequests}
          WHERE status = 'pending'
          ORDER BY created_at ASC, id ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        UPDATE ${this.tables.runtimeRequests} AS request
        SET status = 'running',
            claimed_at = NOW(),
            updated_at = NOW()
        FROM next_request
        WHERE request.id = next_request.id
        RETURNING request.*
      `);
      await client.query("COMMIT");
      const row = claimed.rows[0];
      return row ? parseRecord(row as Record<string, unknown>) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async completeRequest(id: string, resultValue?: unknown): Promise<PandaRuntimeRequestRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runtimeRequests}
      SET status = 'completed',
          result = $2::jsonb,
          error = NULL,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [
      requireTrimmedRequestId(id),
      toJson(resultValue),
    ]);
    return parseRecord(result.rows[0] as Record<string, unknown>);
  }

  async failRequest(id: string, error: string): Promise<PandaRuntimeRequestRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.runtimeRequests}
      SET status = 'failed',
          error = $2,
          finished_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [
      requireTrimmedRequestId(id),
      error,
    ]);
    return parseRecord(result.rows[0] as Record<string, unknown>);
  }

  async getRequest(id: string): Promise<PandaRuntimeRequestRecord> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.runtimeRequests}
      WHERE id = $1
    `, [requireTrimmedRequestId(id)]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Unknown runtime request ${id}`);
    }

    return parseRecord(row as Record<string, unknown>);
  }

  async listenPendingRequests(listener: () => Promise<void> | void): Promise<() => Promise<void>> {
    const client = await this.pool.connect();
    const handleNotification = (message: { channel: string; payload?: string }) => {
      if (message.channel !== this.notificationChannel) {
        return;
      }

      void listener();
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
