import type {Pool, PoolClient} from "pg";

import type {RememberedRoute} from "../../../domain/channels/types.js";
import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier, toJson, toMillis} from "../../threads/runtime/postgres-shared.js";
import {buildSessionRouteTableNames, type SessionRouteTableNames} from "./postgres-shared.js";
import type {SessionRouteInput, SessionRouteLookup, SessionRouteRecord} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface SessionRouteRepoOptions {
  pool: PgPoolLike;
}

function requireTrimmed(field: string, value: string | undefined | null): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Session route ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeLookup(lookup: SessionRouteLookup): SessionRouteLookup {
  return {
    sessionId: requireTrimmed("session id", lookup.sessionId),
    identityId: lookup.identityId?.trim() || undefined,
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

function normalizeInput(input: SessionRouteInput): SessionRouteInput {
  return {
    sessionId: requireTrimmed("session id", input.sessionId),
    identityId: input.identityId?.trim() || undefined,
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

function parseRecord(row: Record<string, unknown>): SessionRouteRecord {
  const route = parseRoute(row);
  return {
    sessionId: String(row.session_id),
    identityId: typeof row.identity_id === "string" && row.identity_id.trim() ? row.identity_id : undefined,
    channel: route.source,
    route,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class SessionRouteRepo {
  private readonly pool: PgPoolLike;
  private readonly tables: SessionRouteTableNames;

  constructor(options: SessionRouteRepoOptions) {
    this.pool = options.pool;
    this.tables = buildSessionRouteTableNames();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.sessionRoutes} (
        session_id TEXT NOT NULL,
        identity_id TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        external_actor_id TEXT,
        external_message_id TEXT,
        captured_at_ms BIGINT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (session_id, identity_id, channel)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_session_routes_lookup_idx`)}
      ON ${this.tables.sessionRoutes} (session_id, identity_id, captured_at_ms DESC)
    `);
  }

  async getLastRoute(lookup: SessionRouteLookup): Promise<RememberedRoute | null> {
    const normalized = normalizeLookup(lookup);
    const values: unknown[] = [normalized.sessionId];
    let sql = `
      SELECT *
      FROM ${this.tables.sessionRoutes}
      WHERE session_id = $1
    `;

    if (normalized.identityId) {
      values.push(normalized.identityId);
      sql += ` AND identity_id = $${values.length}`;
    } else {
      sql += " AND identity_id = ''";
    }

    if (normalized.channel) {
      values.push(normalized.channel);
      sql += ` AND channel = $${values.length}`;
    }

    sql += " ORDER BY captured_at_ms DESC, updated_at DESC LIMIT 1";
    const result = await this.pool.query(sql, values);
    const row = result.rows[0];
    return row ? parseRoute(row as Record<string, unknown>) : null;
  }

  async saveLastRoute(input: SessionRouteInput): Promise<SessionRouteRecord> {
    const normalized = normalizeInput(input);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.sessionRoutes} (
        session_id,
        identity_id,
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
        $8,
        $9::jsonb
      )
      ON CONFLICT (session_id, identity_id, channel)
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
      normalized.sessionId,
      normalized.identityId ?? "",
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
