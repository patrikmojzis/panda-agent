import type {Pool, PoolClient} from "pg";

import type {RememberedRoute} from "../../../domain/channels/types.js";
import {quoteIdentifier, toJson, toMillis} from "../runtime/postgres-shared.js";
import {buildThreadRouteTableNames, type ThreadRouteTableNames} from "./postgres-shared.js";
import type {ThreadRouteInput, ThreadRouteLookup, ThreadRouteRecord} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface ThreadRouteRepoOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
}

function requireTrimmed(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Thread route ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeLookup(lookup: ThreadRouteLookup): ThreadRouteLookup {
  return {
    threadId: requireTrimmed("thread id", lookup.threadId),
    channel: lookup.channel?.trim() || undefined,
  };
}

function normalizeRoute(route: RememberedRoute): RememberedRoute {
  return {
    source: requireTrimmed("source", route.source),
    connectorKey: requireTrimmed("connector key", route.connectorKey),
    externalConversationId: requireTrimmed("conversation id", route.externalConversationId),
    externalActorId: route.externalActorId?.trim() || undefined,
    externalMessageId: route.externalMessageId?.trim() || undefined,
    capturedAt: route.capturedAt,
  };
}

function normalizeInput(input: ThreadRouteInput): ThreadRouteInput {
  return {
    threadId: requireTrimmed("thread id", input.threadId),
    route: normalizeRoute(input.route),
  };
}

function parseRoute(row: Record<string, unknown>): RememberedRoute {
  return {
    source: String(row.channel),
    connectorKey: String(row.connector_key),
    externalConversationId: String(row.external_conversation_id),
    externalActorId: typeof row.external_actor_id === "string" ? row.external_actor_id : undefined,
    externalMessageId: typeof row.external_message_id === "string" ? row.external_message_id : undefined,
    capturedAt: Number(row.captured_at_ms),
  };
}

function parseRecord(row: Record<string, unknown>): ThreadRouteRecord {
  const route = parseRoute(row);
  return {
    threadId: String(row.thread_id),
    channel: route.source,
    route,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class ThreadRouteRepo {
  private readonly pool: PgPoolLike;
  private readonly tables: ThreadRouteTableNames;

  constructor(options: ThreadRouteRepoOptions) {
    this.pool = options.pool;
    this.tables = buildThreadRouteTableNames(options.tablePrefix ?? "thread_runtime");
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.threadRoutes} (
        thread_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        external_actor_id TEXT,
        external_message_id TEXT,
        captured_at_ms BIGINT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (thread_id, channel)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_thread_routes_lookup_idx`)}
      ON ${this.tables.threadRoutes} (thread_id, captured_at_ms DESC)
    `);
  }

  async getLastRoute(lookup: ThreadRouteLookup): Promise<RememberedRoute | null> {
    const normalized = normalizeLookup(lookup);
    const values: unknown[] = [normalized.threadId];
    let sql = `
      SELECT *
      FROM ${this.tables.threadRoutes}
      WHERE thread_id = $1
    `;

    if (normalized.channel) {
      values.push(normalized.channel);
      sql += ` AND channel = $${values.length}`;
    }

    sql += " ORDER BY captured_at_ms DESC, updated_at DESC LIMIT 1";
    const result = await this.pool.query(sql, values);
    const row = result.rows[0];
    return row ? parseRoute(row as Record<string, unknown>) : null;
  }

  async saveLastRoute(input: ThreadRouteInput): Promise<ThreadRouteRecord> {
    const normalized = normalizeInput(input);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.threadRoutes} (
        thread_id,
        channel,
        connector_key,
        external_conversation_id,
        external_actor_id,
        external_message_id,
        captured_at_ms,
        metadata
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8::jsonb
      )
      ON CONFLICT (thread_id, channel)
      DO UPDATE SET
        connector_key = EXCLUDED.connector_key,
        external_conversation_id = EXCLUDED.external_conversation_id,
        external_actor_id = EXCLUDED.external_actor_id,
        external_message_id = EXCLUDED.external_message_id,
        captured_at_ms = EXCLUDED.captured_at_ms,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `, [
      normalized.threadId,
      normalized.route.source,
      normalized.route.connectorKey,
      normalized.route.externalConversationId,
      normalized.route.externalActorId ?? null,
      normalized.route.externalMessageId ?? null,
      normalized.route.capturedAt,
      toJson(normalized.route),
    ]);

    return parseRecord(result.rows[0] as Record<string, unknown>);
  }
}
