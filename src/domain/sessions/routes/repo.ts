import type {RememberedRoute} from "../../channels/types.js";
import {requireTimestampMillis, toJson} from "../../../lib/postgres-values.js";
import {isUniqueViolation} from "../../../lib/postgres-errors.js";
import type {PgPoolLike} from "../../../lib/postgres-query.js";
import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {buildSessionRouteTableNames, type SessionRouteTableNames} from "./postgres-shared.js";
import {ensurePostgresSessionRouteSchema} from "./postgres-schema.js";
import type {SessionRouteInput, SessionRouteLookup, SessionRouteRecord} from "./types.js";

export interface SessionRouteRepoOptions {
  pool: PgPoolLike;
}

function requireSessionRouteString(field: string, value: unknown): string {
  return requireNonEmptyString(value, `Session route ${field} must not be empty.`);
}

function normalizeLookup(lookup: SessionRouteLookup): SessionRouteLookup {
  return {
    sessionId: requireSessionRouteString("session id", lookup.sessionId),
    identityId: trimToUndefined(lookup.identityId),
    channel: trimToUndefined(lookup.channel),
  };
}

function normalizeRoute(route: RememberedRoute): RememberedRoute {
  if (!Number.isSafeInteger(route.capturedAt)) {
    throw new Error("Session route capturedAt must be a safe integer.");
  }

  return {
    source: requireSessionRouteString("source", route.source),
    connectorKey: requireSessionRouteString("connector key", route.connectorKey),
    externalConversationId: requireSessionRouteString("conversation id", route.externalConversationId),
    externalActorId: trimToUndefined(route.externalActorId),
    externalMessageId: trimToUndefined(route.externalMessageId),
    capturedAt: route.capturedAt,
  };
}

function normalizeInput(input: SessionRouteInput): SessionRouteInput {
  return {
    sessionId: requireSessionRouteString("session id", input.sessionId),
    identityId: trimToUndefined(input.identityId),
    route: normalizeRoute(input.route),
  };
}

function parseRequiredBigintNumber(field: string, value: unknown): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }

  throw new Error(`Session route ${field} must be a safe integer.`);
}

function parseRoute(row: Record<string, unknown>): RememberedRoute {
  return {
    source: requireSessionRouteString("source", row.channel),
    connectorKey: requireSessionRouteString("connector key", row.connector_key),
    externalConversationId: requireSessionRouteString("conversation id", row.external_conversation_id),
    externalActorId: typeof row.external_actor_id === "string" ? row.external_actor_id : undefined,
    externalMessageId: typeof row.external_message_id === "string" ? row.external_message_id : undefined,
    capturedAt: parseRequiredBigintNumber("capturedAt", row.captured_at_ms),
  };
}

function parseRecord(row: Record<string, unknown>): SessionRouteRecord {
  const route = parseRoute(row);
  return {
    sessionId: requireSessionRouteString("session id", row.session_id),
    identityId: typeof row.identity_id === "string" && row.identity_id.trim() ? row.identity_id : undefined,
    channel: route.source,
    route,
    createdAt: requireTimestampMillis(row.created_at, "Session route created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Session route updated_at must be a valid timestamp."),
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
    await ensurePostgresSessionRouteSchema(this.pool);
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
      sql += " AND identity_id IS NULL";
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
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      try {
        const inserted = await client.query(`
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
          RETURNING *
        `, [
          normalized.sessionId,
          normalized.identityId ?? null,
          normalized.route.source,
          normalized.route.connectorKey,
          normalized.route.externalConversationId,
          normalized.route.externalActorId ?? null,
          normalized.route.externalMessageId ?? null,
          normalized.route.capturedAt,
          toJson(normalized.route),
        ]);
        return parseRecord(inserted.rows[0] as Record<string, unknown>);
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }
      }

      await client.query("BEGIN");
      inTransaction = true;

      const result = normalized.identityId
        ? await client.query(`
          UPDATE ${this.tables.sessionRoutes}
          SET connector_key = $4,
              external_conversation_id = $5,
              external_actor_id = $6,
              external_message_id = $7,
              captured_at_ms = $8,
              metadata = $9::jsonb,
              updated_at = NOW()
          WHERE session_id = $1
            AND identity_id = $2
            AND channel = $3
          RETURNING *
        `, [
          normalized.sessionId,
          normalized.identityId,
          normalized.route.source,
          normalized.route.connectorKey,
          normalized.route.externalConversationId,
          normalized.route.externalActorId ?? null,
          normalized.route.externalMessageId ?? null,
          normalized.route.capturedAt,
          toJson(normalized.route),
        ])
        : await client.query(`
          UPDATE ${this.tables.sessionRoutes}
          SET connector_key = $3,
              external_conversation_id = $4,
              external_actor_id = $5,
              external_message_id = $6,
              captured_at_ms = $7,
              metadata = $8::jsonb,
              updated_at = NOW()
          WHERE session_id = $1
            AND identity_id IS NULL
            AND channel = $2
          RETURNING *
        `, [
          normalized.sessionId,
          normalized.route.source,
          normalized.route.connectorKey,
          normalized.route.externalConversationId,
          normalized.route.externalActorId ?? null,
          normalized.route.externalMessageId ?? null,
          normalized.route.capturedAt,
          toJson(normalized.route),
        ]);
      const row = result.rows[0];
      if (!row) {
        throw new Error("Failed to update remembered session route after uniqueness conflict.");
      }

      await client.query("COMMIT");
      inTransaction = false;
      return parseRecord(row as Record<string, unknown>);
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
