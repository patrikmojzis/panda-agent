import type {DeliveryContext, RememberedRoute} from "../../channels/types.js";
import {isUniqueViolation} from "../../../lib/postgres-errors.js";
import {requireTimestampMillis, toJson} from "../../../lib/postgres-values.js";
import {isJsonObject} from "../../../lib/json.js";
import type {PgPoolLike} from "../../../lib/postgres-query.js";
import {requireNonEmptyString, trimToUndefined} from "../../../lib/strings.js";
import {buildSessionRouteTableNames, type SessionRouteTableNames} from "./postgres-shared.js";
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

function readOptionalDeliveryContext(value: unknown, label: string): DeliveryContext | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function readRouteDeliveryContext(row: Record<string, unknown>): DeliveryContext | undefined {
  const metadata = row.metadata;
  if (metadata === undefined || metadata === null) {
    return undefined;
  }

  if (!isJsonObject(metadata)) {
    return undefined;
  }

  return readOptionalDeliveryContext(metadata.deliveryContext, "Session route delivery context");
}

function normalizeRoute(route: RememberedRoute): RememberedRoute {
  if (!Number.isSafeInteger(route.capturedAt)) {
    throw new Error("Session route capturedAt must be a safe integer.");
  }

  const deliveryContext = readOptionalDeliveryContext(
    route.deliveryContext,
    "Session route delivery context",
  );

  return {
    source: requireSessionRouteString("source", route.source),
    connectorKey: requireSessionRouteString("connector key", route.connectorKey),
    externalConversationId: requireSessionRouteString("conversation id", route.externalConversationId),
    externalActorId: trimToUndefined(route.externalActorId),
    externalMessageId: trimToUndefined(route.externalMessageId),
    capturedAt: route.capturedAt,
    ...(deliveryContext !== undefined ? {deliveryContext} : {}),
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
  const deliveryContext = readRouteDeliveryContext(row);

  return {
    source: requireSessionRouteString("source", row.channel),
    connectorKey: requireSessionRouteString("connector key", row.connector_key),
    externalConversationId: requireSessionRouteString("conversation id", row.external_conversation_id),
    externalActorId: typeof row.external_actor_id === "string" ? row.external_actor_id : undefined,
    externalMessageId: typeof row.external_message_id === "string" ? row.external_message_id : undefined,
    capturedAt: parseRequiredBigintNumber("capturedAt", row.captured_at_ms),
    ...(deliveryContext !== undefined ? {deliveryContext} : {}),
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
    const identityPredicate = normalized.identityId
      ? "identity_id = $2"
      : "identity_id IS NULL";
    const values = [
      normalized.sessionId,
      normalized.identityId ?? null,
      normalized.route.source,
      normalized.route.connectorKey,
      normalized.route.externalConversationId,
      normalized.route.externalActorId ?? null,
      normalized.route.externalMessageId ?? null,
      normalized.route.capturedAt,
      toJson(normalized.route),
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await this.pool.query(`
      WITH updated AS (
        UPDATE ${this.tables.sessionRoutes}
        SET connector_key = $4,
            external_conversation_id = $5,
            external_actor_id = $6,
            external_message_id = $7,
            captured_at_ms = $8::bigint,
            metadata = $9::jsonb,
            updated_at = NOW()
        WHERE session_id = $1
          AND ${identityPredicate}
          AND channel = $3
          AND captured_at_ms <= $8::bigint
        RETURNING *
      ), inserted AS (
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
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM ${this.tables.sessionRoutes}
          WHERE session_id = $1 AND ${identityPredicate} AND channel = $3
        )
        RETURNING *
      ), current_route AS (
        SELECT * FROM ${this.tables.sessionRoutes}
        WHERE session_id = $1 AND ${identityPredicate} AND channel = $3
      )
      SELECT * FROM updated
      UNION ALL SELECT * FROM inserted
      UNION ALL SELECT * FROM current_route
        WHERE NOT EXISTS (SELECT 1 FROM updated)
          AND NOT EXISTS (SELECT 1 FROM inserted)
      LIMIT 1
        `, values);
        const row = result.rows[0];
        if (row) return parseRecord(row as Record<string, unknown>);
      } catch (error) {
        if (!isUniqueViolation(error) || attempt > 0) throw error;
      }
      // A concurrent insert can win after this statement's snapshot. The
      // second statement reads its committed row; uncontended ingress stays
      // one round trip.
      if (attempt === 0) continue;
    }
    throw new Error("Failed to persist remembered session route after a concurrent insert.");
  }
}
