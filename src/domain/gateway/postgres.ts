import {randomUUID} from "node:crypto";

import {requireNonNegativeInteger} from "../../lib/numbers.js";
import {generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches} from "../../lib/opaque-tokens.js";
import {isUniqueViolation} from "../../lib/postgres-errors.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {toJson} from "../../lib/postgres-values.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {
  normalizeGatewayEventType,
  normalizeGatewaySourceId,
  parseGatewayDeliveryMode,
  parseGatewayEventRow,
  parseGatewayEventTypeRow,
  parseGatewaySourceRow,
  parseGatewayStrikeRow,
  parseNonNegativeBigintCounter,
  parseOptionalGatewayMetadata,
  requireGatewayTrimmedString,
} from "./postgres-rows.js";
import {ensurePostgresGatewaySchema} from "./postgres-schema.js";
import {buildGatewayTableNames} from "./postgres-shared.js";
import type {
  CreateGatewaySourceInput,
  GatewayAccessTokenRecord,
  GatewayDeliveryMode,
  GatewayEventInput,
  GatewayEventRecord,
  GatewayEventTypeRecord,
  GatewaySourceRecord,
  GatewaySourceSecretResult,
  GatewayStoredEventResult,
  GatewayStrikeRecord,
} from "./types.js";

const ACCESS_TOKEN_PREFIX = "pga";
const CLIENT_ID_PREFIX = "pgc";
const CLIENT_SECRET_PREFIX = "pgs";
const DEFAULT_MAX_ACTIVE_ACCESS_TOKENS = 20;
const PROCESSING_STALE_MS = 5 * 60_000;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
const RATE_LIMIT_BUCKET_RETENTION_MS = 24 * 60 * 60_000;

export class GatewayEventConflictError extends Error {
  constructor(readonly existing: GatewayEventRecord) {
    super("Idempotency key already exists with a different event body.");
    this.name = "GatewayEventConflictError";
  }
}

function sameIdempotentEventBody(existing: GatewayEventRecord, input: GatewayEventInput): boolean {
  return existing.type === normalizeGatewayEventType(input.type)
    && existing.deliveryRequested === parseGatewayDeliveryMode(input.deliveryRequested)
    && (existing.occurredAt ?? null) === (input.occurredAt ?? null)
    && existing.textBytes === input.textBytes
    && existing.textSha256 === input.textSha256;
}

export class PostgresGatewayStore {
  private readonly pool: PgQueryable;
  private readonly tables = buildGatewayTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private lastRateLimitCleanupAt = 0;

  constructor(options: {pool: PgQueryable}) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresGatewaySchema(this.pool);
  }

  async createSource(input: CreateGatewaySourceInput): Promise<GatewaySourceSecretResult> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const clientId = generateOpaqueToken(CLIENT_ID_PREFIX);
    const clientSecret = generateOpaqueToken(CLIENT_SECRET_PREFIX);
    if (input.sessionId?.trim()) {
      const sessionResult = await this.pool.query(
        `SELECT agent_key FROM ${this.sessionTables.sessions} WHERE id = $1`,
        [input.sessionId.trim()],
      );
      const sessionRow = sessionResult.rows[0] as {agent_key?: unknown} | undefined;
      if (!sessionRow) {
        throw new Error(`Unknown gateway route session ${input.sessionId}.`);
      }
      if (requireGatewayTrimmedString("Gateway route session agent key", sessionRow.agent_key) !== input.agentKey) {
        throw new Error(`Gateway route session ${input.sessionId} does not belong to agent ${input.agentKey}.`);
      }
    }
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.sources} (
        source_id,
        name,
        client_id,
        client_secret_hash,
        agent_key,
        identity_id,
        session_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [
      sourceId,
      input.name?.trim() || sourceId,
      clientId,
      hashOpaqueToken(clientSecret),
      requireGatewayTrimmedString("Agent key", input.agentKey),
      requireGatewayTrimmedString("Identity id", input.identityId),
      input.sessionId?.trim() || null,
    ]);

    return {
      source: parseGatewaySourceRow(result.rows[0] as Record<string, unknown>),
      clientSecret,
    };
  }

  async getSource(sourceId: string): Promise<GatewaySourceRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.sources} WHERE source_id = $1`,
      [normalizeGatewaySourceId(sourceId)],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown gateway source ${sourceId}.`);
    }
    return parseGatewaySourceRow(row);
  }

  async listSources(): Promise<readonly GatewaySourceRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.sources} ORDER BY created_at DESC, source_id ASC`,
    );
    return result.rows.map((row) => parseGatewaySourceRow(row as Record<string, unknown>));
  }

  async rotateSourceSecret(sourceId: string): Promise<GatewaySourceSecretResult> {
    const clientSecret = generateOpaqueToken(CLIENT_SECRET_PREFIX);
    const normalizedSourceId = normalizeGatewaySourceId(sourceId);
    const result = await this.pool.query(`
      UPDATE ${this.tables.sources}
      SET client_secret_hash = $2, status = 'active', suspended_at = NULL, suspend_reason = NULL, updated_at = NOW()
      WHERE source_id = $1
      RETURNING *
    `, [
      normalizedSourceId,
      hashOpaqueToken(clientSecret),
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown gateway source ${sourceId}.`);
    }
    await this.pool.query(
      `DELETE FROM ${this.tables.accessTokens} WHERE source_id = $1`,
      [normalizedSourceId],
    );
    return {
      source: parseGatewaySourceRow(row),
      clientSecret,
    };
  }

  async suspendSource(sourceId: string, reason: string): Promise<GatewaySourceRecord> {
    const normalizedSourceId = normalizeGatewaySourceId(sourceId);
    const result = await this.pool.query(`
      UPDATE ${this.tables.sources}
      SET status = 'suspended', suspended_at = NOW(), suspend_reason = $2, updated_at = NOW()
      WHERE source_id = $1
      RETURNING *
    `, [
      normalizedSourceId,
      reason.trim() || "suspended",
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown gateway source ${sourceId}.`);
    }
    await this.pool.query(
      `DELETE FROM ${this.tables.accessTokens} WHERE source_id = $1`,
      [normalizedSourceId],
    );
    return parseGatewaySourceRow(row);
  }

  async resumeSource(sourceId: string): Promise<GatewaySourceSecretResult> {
    return this.rotateSourceSecret(sourceId);
  }

  async verifyClientCredentials(input: {
    clientId: string;
    clientSecret: string;
  }): Promise<GatewaySourceRecord | null> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.sources} WHERE client_id = $1`,
      [requireGatewayTrimmedString("Client id", input.clientId)],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || !opaqueTokenMatches(input.clientSecret, requireGatewayTrimmedString("Gateway client secret hash", row.client_secret_hash))) {
      return null;
    }
    const source = parseGatewaySourceRow(row);
    return source.status === "active" ? source : null;
  }

  async createAccessToken(input: {
    sourceId: string;
    expiresInMs: number;
    maxActiveTokens?: number;
  }): Promise<GatewayAccessTokenRecord> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const token = generateOpaqueToken(ACCESS_TOKEN_PREFIX);
    const expiresAt = Date.now() + Math.max(1_000, Math.floor(input.expiresInMs));
    const maxActiveTokens = Math.max(1, Math.floor(input.maxActiveTokens ?? DEFAULT_MAX_ACTIVE_ACCESS_TOKENS));
    await this.pool.query(
      `DELETE FROM ${this.tables.accessTokens} WHERE source_id = $1 AND expires_at <= NOW()`,
      [sourceId],
    );
    await this.pool.query(`
      INSERT INTO ${this.tables.accessTokens} (
        id,
        token_hash,
        source_id,
        expires_at
      ) VALUES ($1, $2, $3, $4)
    `, [
      randomUUID(),
      hashOpaqueToken(token),
      sourceId,
      new Date(expiresAt),
    ]);
    await this.pool.query(`
      DELETE FROM ${this.tables.accessTokens}
      WHERE source_id = $1
        AND id NOT IN (
          SELECT id
          FROM ${this.tables.accessTokens}
          WHERE source_id = $1
          ORDER BY expires_at DESC, created_at DESC
          LIMIT $2
        )
    `, [sourceId, maxActiveTokens]);
    return {
      token,
      source: await this.getSource(sourceId),
      expiresAt,
    };
  }

  async resolveAccessToken(token: string): Promise<GatewaySourceRecord | null> {
    const result = await this.pool.query(`
      SELECT source.*
      FROM ${this.tables.accessTokens} AS access
      JOIN ${this.tables.sources} AS source
        ON source.source_id = access.source_id
      WHERE access.token_hash = $1
        AND access.expires_at > NOW()
        AND source.status = 'active'
      LIMIT 1
    `, [hashOpaqueToken(requireGatewayTrimmedString("Access token", token))]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseGatewaySourceRow(row) : null;
  }

  async upsertEventType(input: {
    sourceId: string;
    type: string;
    delivery: GatewayDeliveryMode;
  }): Promise<GatewayEventTypeRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.eventTypes} (
        source_id,
        event_type,
        delivery
      ) VALUES ($1, $2, $3)
      ON CONFLICT (source_id, event_type)
      DO UPDATE SET delivery = EXCLUDED.delivery, updated_at = NOW()
      RETURNING *
    `, [
      normalizeGatewaySourceId(input.sourceId),
      normalizeGatewayEventType(input.type),
      parseGatewayDeliveryMode(input.delivery),
    ]);
    return parseGatewayEventTypeRow(result.rows[0] as Record<string, unknown>);
  }

  async getEventType(sourceId: string, type: string): Promise<GatewayEventTypeRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.eventTypes}
      WHERE source_id = $1 AND event_type = $2
    `, [
      normalizeGatewaySourceId(sourceId),
      normalizeGatewayEventType(type),
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseGatewayEventTypeRow(row) : null;
  }

  async listEventTypes(sourceId: string): Promise<readonly GatewayEventTypeRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.eventTypes}
      WHERE source_id = $1
      ORDER BY event_type ASC
    `, [normalizeGatewaySourceId(sourceId)]);
    return result.rows.map((row) => parseGatewayEventTypeRow(row as Record<string, unknown>));
  }

  async storeEvent(input: GatewayEventInput): Promise<GatewayStoredEventResult> {
    const id = randomUUID();
    try {
      const result = await this.pool.query(`
        INSERT INTO ${this.tables.events} (
          id,
          source_id,
          event_type,
          delivery_requested,
          delivery_effective,
          occurred_at,
          idempotency_key,
          text,
          text_bytes,
          text_sha256
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING *
      `, [
        id,
        normalizeGatewaySourceId(input.sourceId),
        normalizeGatewayEventType(input.type),
        parseGatewayDeliveryMode(input.deliveryRequested),
        parseGatewayDeliveryMode(input.deliveryEffective),
        input.occurredAt === undefined ? null : new Date(input.occurredAt),
        requireGatewayTrimmedString("Idempotency key", input.idempotencyKey),
        input.text,
        input.textBytes,
        input.textSha256,
      ]);
      return {
        event: parseGatewayEventRow(result.rows[0] as Record<string, unknown>),
        inserted: true,
      };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.getEventByIdempotencyKey(input.sourceId, input.idempotencyKey);
      if (!sameIdempotentEventBody(existing, input)) {
        throw new GatewayEventConflictError(existing);
      }
      return {
        event: existing,
        inserted: false,
      };
    }
  }

  async getEvent(eventId: string): Promise<GatewayEventRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.events} WHERE id = $1`,
      [eventId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown gateway event ${eventId}.`);
    }
    return parseGatewayEventRow(row);
  }

  async getEventByIdempotencyKey(sourceId: string, idempotencyKey: string): Promise<GatewayEventRecord> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.events}
      WHERE source_id = $1 AND idempotency_key = $2
    `, [
      normalizeGatewaySourceId(sourceId),
      requireGatewayTrimmedString("Idempotency key", idempotencyKey),
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown gateway idempotency key ${idempotencyKey}.`);
    }
    return parseGatewayEventRow(row);
  }

  async listEvents(input: {sourceId?: string; limit?: number} = {}): Promise<readonly GatewayEventRecord[]> {
    const limit = Math.min(200, Math.max(1, Math.floor(input.limit ?? 50)));
    const result = input.sourceId
      ? await this.pool.query(`
        SELECT *
        FROM ${this.tables.events}
        WHERE source_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `, [normalizeGatewaySourceId(input.sourceId), limit])
      : await this.pool.query(`
        SELECT *
        FROM ${this.tables.events}
        ORDER BY created_at DESC
        LIMIT $1
      `, [limit]);
    return result.rows.map((row) => parseGatewayEventRow(row as Record<string, unknown>));
  }

  async useRateLimit(input: {
    key: string;
    windowMs: number;
    cost?: number;
    limit: number;
  }): Promise<{allowed: boolean; used: number}> {
    const cost = Math.max(1, Math.floor(input.cost ?? 1));
    const limit = Math.max(1, Math.floor(input.limit));
    const windowMs = Math.max(1, Math.floor(input.windowMs));
    const staleBefore = new Date(Date.now() - windowMs);
    await this.cleanupRateLimitBuckets(windowMs);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.rateLimits} (
        bucket_key,
        window_start,
        used
      ) VALUES ($1, NOW(), $2)
      ON CONFLICT (bucket_key)
      DO UPDATE SET
        window_start = CASE
          WHEN ${this.tables.rateLimits}.window_start < $3 THEN NOW()
          ELSE ${this.tables.rateLimits}.window_start
        END,
        used = CASE
          WHEN ${this.tables.rateLimits}.window_start < $3 THEN EXCLUDED.used
          ELSE ${this.tables.rateLimits}.used + EXCLUDED.used
        END,
        updated_at = NOW()
      RETURNING used
    `, [
      requireGatewayTrimmedString("Rate limit key", input.key),
      cost,
      staleBefore,
    ]);
    const used = parseNonNegativeBigintCounter(
      "Gateway rate-limit usage",
      (result.rows[0] as {used?: unknown} | undefined)?.used ?? cost,
    );
    return {
      allowed: used <= limit,
      used,
    };
  }

  private async cleanupRateLimitBuckets(windowMs: number): Promise<void> {
    const now = Date.now();
    if (now - this.lastRateLimitCleanupAt < RATE_LIMIT_CLEANUP_INTERVAL_MS) {
      return;
    }
    this.lastRateLimitCleanupAt = now;
    const deleteBefore = new Date(now - Math.max(RATE_LIMIT_BUCKET_RETENTION_MS, windowMs * 2));
    await this.pool.query(
      `DELETE FROM ${this.tables.rateLimits} WHERE updated_at < $1`,
      [deleteBefore],
    );
  }

  async claimPendingEvents(limit: number): Promise<readonly GatewayEventRecord[]> {
    const staleBefore = new Date(Date.now() - PROCESSING_STALE_MS);
    const claimId = randomUUID();
    const result = await this.pool.query(`
      UPDATE ${this.tables.events}
      SET status = 'processing',
          claim_id = $3,
          claimed_at = NOW()
      WHERE id IN (
        SELECT id
        FROM ${this.tables.events}
        WHERE status = 'pending'
          OR (status = 'processing' AND claimed_at IS NOT NULL AND claimed_at < $2)
        ORDER BY created_at ASC
        LIMIT $1
      )
        AND (
          ${this.tables.events}.status = 'pending'
          OR (
            ${this.tables.events}.status = 'processing'
            AND ${this.tables.events}.claimed_at IS NOT NULL
            AND ${this.tables.events}.claimed_at < $2
          )
        )
      RETURNING *
    `, [
      Math.min(100, Math.max(1, Math.floor(limit))),
      staleBefore,
      claimId,
    ]);
    return result.rows.map((row) => parseGatewayEventRow(row as Record<string, unknown>));
  }

  async reserveEventDelivery(input: {
    eventId: string;
    claimId: string;
    riskScore: number;
    metadata?: GatewayEventRecord["metadata"];
  }): Promise<GatewayEventRecord | null> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.events}
      SET status = 'delivering',
          risk_score = $3,
          metadata = $4::jsonb,
          claimed_at = NOW()
      WHERE id = $1
        AND status = 'processing'
        AND claim_id = $2
      RETURNING *
    `, [
      input.eventId,
      input.claimId,
      input.riskScore,
      toJson(parseOptionalGatewayMetadata("Gateway event metadata", input.metadata)),
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseGatewayEventRow(row) : null;
  }

  async markEventDelivered(input: {
    eventId: string;
    claimId?: string;
    threadId: string;
    riskScore: number;
    metadata?: GatewayEventRecord["metadata"];
  }): Promise<GatewayEventRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.events}
      SET status = 'delivered',
          risk_score = $2,
          thread_id = $3,
          metadata = $4::jsonb,
          text = '',
          processed_at = NOW(),
          delivered_at = NOW(),
          text_scrubbed_at = COALESCE(text_scrubbed_at, NOW())
      WHERE id = $1
        AND status = 'delivering'
        AND ($5::text IS NULL OR claim_id = $5)
      RETURNING *
    `, [
      input.eventId,
      input.riskScore,
      input.threadId,
      toJson(parseOptionalGatewayMetadata("Gateway event metadata", input.metadata)),
      input.claimId ?? null,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseGatewayEventRow(row) : await this.getEvent(input.eventId);
  }

  async markEventQuarantined(input: {
    eventId: string;
    claimId?: string;
    riskScore: number;
    reason: string;
    metadata?: GatewayEventRecord["metadata"];
  }): Promise<GatewayEventRecord> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.events}
      SET status = 'quarantined',
          risk_score = $2,
          reason = $3,
          metadata = $4::jsonb,
          text = '',
          processed_at = NOW(),
          text_scrubbed_at = COALESCE(text_scrubbed_at, NOW())
      WHERE id = $1
        AND status IN ('pending', 'processing', 'delivering')
        AND ($5::text IS NULL OR claim_id = $5)
      RETURNING *
    `, [
      input.eventId,
      input.riskScore,
      input.reason,
      toJson(parseOptionalGatewayMetadata("Gateway event metadata", input.metadata)),
      input.claimId ?? null,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseGatewayEventRow(row) : await this.getEvent(input.eventId);
  }

  async recordStrike(input: {
    sourceId: string;
    kind: string;
    reason: string;
    eventId?: string;
    metadata?: GatewayStrikeRecord["metadata"];
  }): Promise<GatewayStrikeRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.strikes} (
        id,
        source_id,
        kind,
        reason,
        event_id,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      RETURNING *
    `, [
      randomUUID(),
      normalizeGatewaySourceId(input.sourceId),
      requireGatewayTrimmedString("Strike kind", input.kind),
      requireGatewayTrimmedString("Strike reason", input.reason),
      input.eventId ?? null,
      toJson(parseOptionalGatewayMetadata("Gateway strike metadata", input.metadata)),
    ]);
    return parseGatewayStrikeRow(result.rows[0] as Record<string, unknown>);
  }

  async countRecentStrikes(input: {
    sourceId: string;
    kind?: string;
    sinceMs: number;
  }): Promise<number> {
    const since = new Date(Date.now() - Math.max(1, Math.floor(input.sinceMs)));
    const result = input.kind
      ? await this.pool.query(`
        SELECT COUNT(*)::INTEGER AS count
        FROM ${this.tables.strikes}
        WHERE source_id = $1 AND kind = $2 AND created_at >= $3
      `, [
        normalizeGatewaySourceId(input.sourceId),
        requireGatewayTrimmedString("Strike kind", input.kind),
        since,
      ])
      : await this.pool.query(`
        SELECT COUNT(*)::INTEGER AS count
        FROM ${this.tables.strikes}
        WHERE source_id = $1 AND created_at >= $2
      `, [
        normalizeGatewaySourceId(input.sourceId),
        since,
      ]);
    return requireNonNegativeInteger(
      (result.rows[0] as {count?: unknown} | undefined)?.count ?? 0,
      "Gateway strike count",
    );
  }

  async recordStrikeAndMaybeSuspend(input: {
    sourceId: string;
    kind: string;
    reason: string;
    eventId?: string;
    threshold: number;
    windowMs: number;
    metadata?: GatewayStrikeRecord["metadata"];
  }): Promise<{strike: GatewayStrikeRecord; recentCount: number; suspended: boolean}> {
    const strike = await this.recordStrike(input);
    const recentCount = await this.countRecentStrikes({
      sourceId: input.sourceId,
      kind: input.kind,
      sinceMs: input.windowMs,
    });
    const suspended = recentCount >= input.threshold;
    if (suspended) {
      await this.suspendSource(
        input.sourceId,
        `${input.kind} threshold reached (${recentCount}/${input.threshold})`,
      );
    }
    return {strike, recentCount, suspended};
  }
}
