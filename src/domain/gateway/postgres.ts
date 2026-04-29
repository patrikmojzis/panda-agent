import {createHash, randomBytes, randomUUID, timingSafeEqual} from "node:crypto";

import type {Pool} from "pg";

import {isUniqueViolation} from "../../lib/postgres-errors.js";
import {
  CREATE_RUNTIME_SCHEMA_SQL,
  quoteIdentifier,
  toJson,
  toMillis,
} from "../threads/runtime/postgres-shared.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
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

interface PgQueryable {
  query: Pool["query"];
}

type PgPoolLike = PgQueryable;

const ACCESS_TOKEN_PREFIX = "pga";
const CLIENT_ID_PREFIX = "pgc";
const CLIENT_SECRET_PREFIX = "pgs";
const DEFAULT_MAX_ACTIVE_ACCESS_TOKENS = 20;
const PROCESSING_STALE_MS = 5 * 60_000;
const RATE_LIMIT_CLEANUP_INTERVAL_MS = 60_000;
const RATE_LIMIT_BUCKET_RETENTION_MS = 24 * 60 * 60_000;

function generateOpaqueToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function hashToken(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function tokenMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(value), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireTrimmed(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }
  return trimmed;
}

export function normalizeGatewaySourceId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(normalized)) {
    throw new Error("Gateway source id must use lowercase letters, numbers, hyphens, or underscores.");
  }
  return normalized;
}

export function normalizeGatewayEventType(value: string): string {
  const normalized = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(normalized)) {
    throw new Error("Gateway event type must use letters, numbers, dots, colons, underscores, or hyphens.");
  }
  return normalized;
}

function parseOptionalMillis(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : toMillis(value);
}

function parseSourceRow(row: Record<string, unknown>): GatewaySourceRecord {
  return {
    sourceId: String(row.source_id),
    name: String(row.name),
    clientId: String(row.client_id),
    agentKey: String(row.agent_key),
    identityId: String(row.identity_id),
    sessionId: row.session_id === null ? undefined : String(row.session_id),
    status: String(row.status) as GatewaySourceRecord["status"],
    suspendedAt: parseOptionalMillis(row.suspended_at),
    suspendReason: row.suspend_reason === null ? undefined : String(row.suspend_reason),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseEventTypeRow(row: Record<string, unknown>): GatewayEventTypeRecord {
  return {
    sourceId: String(row.source_id),
    type: String(row.event_type),
    delivery: String(row.delivery) as GatewayDeliveryMode,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseEventRow(row: Record<string, unknown>): GatewayEventRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    type: String(row.event_type),
    deliveryRequested: String(row.delivery_requested) as GatewayDeliveryMode,
    deliveryEffective: String(row.delivery_effective) as GatewayDeliveryMode,
    occurredAt: parseOptionalMillis(row.occurred_at),
    idempotencyKey: String(row.idempotency_key),
    text: String(row.text),
    textBytes: Number(row.text_bytes),
    textSha256: String(row.text_sha256),
    status: String(row.status) as GatewayEventRecord["status"],
    riskScore: row.risk_score === null ? undefined : Number(row.risk_score),
    reason: row.reason === null ? undefined : String(row.reason),
    threadId: row.thread_id === null ? undefined : String(row.thread_id),
    metadata: row.metadata === null ? undefined : row.metadata as GatewayEventRecord["metadata"],
    createdAt: toMillis(row.created_at),
    claimId: row.claim_id === null ? undefined : String(row.claim_id),
    claimedAt: parseOptionalMillis(row.claimed_at),
    processedAt: parseOptionalMillis(row.processed_at),
    deliveredAt: parseOptionalMillis(row.delivered_at),
    textScrubbedAt: parseOptionalMillis(row.text_scrubbed_at),
  };
}

function parseStrikeRow(row: Record<string, unknown>): GatewayStrikeRecord {
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    kind: String(row.kind),
    reason: String(row.reason),
    eventId: row.event_id === null ? undefined : String(row.event_id),
    metadata: row.metadata === null ? undefined : row.metadata as GatewayStrikeRecord["metadata"],
    createdAt: toMillis(row.created_at),
  };
}

export class GatewayEventConflictError extends Error {
  constructor(readonly existing: GatewayEventRecord) {
    super("Idempotency key already exists with a different event body.");
    this.name = "GatewayEventConflictError";
  }
}

function sameIdempotentEventBody(existing: GatewayEventRecord, input: GatewayEventInput): boolean {
  return existing.type === normalizeGatewayEventType(input.type)
    && existing.deliveryRequested === input.deliveryRequested
    && (existing.occurredAt ?? null) === (input.occurredAt ?? null)
    && existing.textBytes === input.textBytes
    && existing.textSha256 === input.textSha256;
}

export class PostgresGatewayStore {
  private readonly pool: PgPoolLike;
  private readonly tables = buildGatewayTableNames();
  private readonly agentTables = buildAgentTableNames();
  private readonly identityTables = buildIdentityTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private lastRateLimitCleanupAt = 0;

  constructor(options: {pool: PgPoolLike}) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.sources} (
        source_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        client_id TEXT NOT NULL UNIQUE,
        client_secret_hash TEXT NOT NULL,
        agent_key TEXT NOT NULL REFERENCES ${this.agentTables.agents}(agent_key) ON DELETE CASCADE,
        identity_id TEXT NOT NULL REFERENCES ${this.identityTables.identities}(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES ${this.sessionTables.sessions}(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'active',
        suspended_at TIMESTAMPTZ,
        suspend_reason TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.eventTypes} (
        source_id TEXT NOT NULL REFERENCES ${this.tables.sources}(source_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        delivery TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source_id, event_type)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.accessTokens} (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        source_id TEXT NOT NULL REFERENCES ${this.tables.sources}(source_id) ON DELETE CASCADE,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_gateway_access_tokens_source_idx`)}
      ON ${this.tables.accessTokens} (source_id, expires_at DESC)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.events} (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES ${this.tables.sources}(source_id) ON DELETE CASCADE,
        event_type TEXT NOT NULL,
        delivery_requested TEXT NOT NULL,
        delivery_effective TEXT NOT NULL,
        occurred_at TIMESTAMPTZ,
        idempotency_key TEXT NOT NULL,
        text TEXT NOT NULL,
        text_bytes INTEGER NOT NULL,
        text_sha256 TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        risk_score DOUBLE PRECISION,
        reason TEXT,
        thread_id TEXT,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        claim_id TEXT,
        claimed_at TIMESTAMPTZ,
        processed_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        text_scrubbed_at TIMESTAMPTZ,
        UNIQUE (source_id, idempotency_key)
      )
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.events}
      ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.events}
      ADD COLUMN IF NOT EXISTS claim_id TEXT
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.events}
      ADD COLUMN IF NOT EXISTS text_scrubbed_at TIMESTAMPTZ
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_gateway_events_pending_idx`)}
      ON ${this.tables.events} (status, created_at)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.rateLimits} (
        bucket_key TEXT PRIMARY KEY,
        window_start TIMESTAMPTZ NOT NULL,
        used BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_gateway_rate_limits_updated_idx`)}
      ON ${this.tables.rateLimits} (updated_at)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.strikes} (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES ${this.tables.sources}(source_id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        event_id TEXT REFERENCES ${this.tables.events}(id) ON DELETE SET NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_gateway_strikes_source_kind_idx`)}
      ON ${this.tables.strikes} (source_id, kind, created_at DESC)
    `);
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
      if (String(sessionRow.agent_key) !== input.agentKey) {
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
      hashToken(clientSecret),
      requireTrimmed("Agent key", input.agentKey),
      requireTrimmed("Identity id", input.identityId),
      input.sessionId?.trim() || null,
    ]);

    return {
      source: parseSourceRow(result.rows[0] as Record<string, unknown>),
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
    return parseSourceRow(row);
  }

  async listSources(): Promise<readonly GatewaySourceRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.sources} ORDER BY created_at DESC, source_id ASC`,
    );
    return result.rows.map((row) => parseSourceRow(row as Record<string, unknown>));
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
      hashToken(clientSecret),
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
      source: parseSourceRow(row),
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
    return parseSourceRow(row);
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
      [requireTrimmed("Client id", input.clientId)],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row || !tokenMatches(input.clientSecret, String(row.client_secret_hash))) {
      return null;
    }
    const source = parseSourceRow(row);
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
      hashToken(token),
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
    `, [hashToken(requireTrimmed("Access token", token))]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseSourceRow(row) : null;
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
      input.delivery,
    ]);
    return parseEventTypeRow(result.rows[0] as Record<string, unknown>);
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
    return row ? parseEventTypeRow(row) : null;
  }

  async listEventTypes(sourceId: string): Promise<readonly GatewayEventTypeRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.eventTypes}
      WHERE source_id = $1
      ORDER BY event_type ASC
    `, [normalizeGatewaySourceId(sourceId)]);
    return result.rows.map((row) => parseEventTypeRow(row as Record<string, unknown>));
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
        input.deliveryRequested,
        input.deliveryEffective,
        input.occurredAt === undefined ? null : new Date(input.occurredAt),
        requireTrimmed("Idempotency key", input.idempotencyKey),
        input.text,
        input.textBytes,
        input.textSha256,
      ]);
      return {
        event: parseEventRow(result.rows[0] as Record<string, unknown>),
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
    return parseEventRow(row);
  }

  async getEventByIdempotencyKey(sourceId: string, idempotencyKey: string): Promise<GatewayEventRecord> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.events}
      WHERE source_id = $1 AND idempotency_key = $2
    `, [
      normalizeGatewaySourceId(sourceId),
      requireTrimmed("Idempotency key", idempotencyKey),
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown gateway idempotency key ${idempotencyKey}.`);
    }
    return parseEventRow(row);
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
    return result.rows.map((row) => parseEventRow(row as Record<string, unknown>));
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
      requireTrimmed("Rate limit key", input.key),
      cost,
      staleBefore,
    ]);
    const used = Number((result.rows[0] as {used?: unknown} | undefined)?.used ?? cost);
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
    return result.rows.map((row) => parseEventRow(row as Record<string, unknown>));
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
      toJson(input.metadata),
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseEventRow(row) : null;
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
      toJson(input.metadata),
      input.claimId ?? null,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseEventRow(row) : await this.getEvent(input.eventId);
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
      toJson(input.metadata),
      input.claimId ?? null,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseEventRow(row) : await this.getEvent(input.eventId);
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
      requireTrimmed("Strike kind", input.kind),
      requireTrimmed("Strike reason", input.reason),
      input.eventId ?? null,
      toJson(input.metadata),
    ]);
    return parseStrikeRow(result.rows[0] as Record<string, unknown>);
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
        requireTrimmed("Strike kind", input.kind),
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
    return Number((result.rows[0] as {count?: unknown} | undefined)?.count ?? 0);
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
