import {randomUUID} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {requireNonNegativeInteger} from "../../lib/numbers.js";
import {generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches} from "../../lib/opaque-tokens.js";
import {isUniqueViolation} from "../../lib/postgres-errors.js";
import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {resolveAgentMediaDir} from "../../lib/data-dir.js";
import {toJson} from "../../lib/postgres-values.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {
  normalizeGatewayDeviceId,
  normalizeGatewayEventType,
  normalizeGatewaySourceId,
  parseGatewayAttachmentRow,
  parseGatewayDeliveryMode,
  parseGatewayDeviceRow,
  parseGatewayEventAttachmentRow,
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
  GatewayAttachmentRecord,
  GatewayAttachmentRefInput,
  GatewayAttachmentUploadInput,
  GatewayDeliveryMode,
  GatewayDeviceCapability,
  GatewayDeviceRecord,
  GatewayEventAttachmentRecord,
  GatewayEventInput,
  GatewayEventRecord,
  GatewayEventTypeRecord,
  GatewaySourceRecord,
  GatewaySourceSecretResult,
  GatewayStoredAttachmentResult,
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
const DEFAULT_ATTACHMENT_RETENTION_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_ATTACHMENT_QUARANTINE_TTL_MS = 24 * 60 * 60_000;

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

export class GatewayAttachmentConflictError extends Error {
  constructor(readonly existing: GatewayAttachmentRecord) {
    super("Idempotency key already exists with a different attachment upload.");
    this.name = "GatewayAttachmentConflictError";
  }
}

export class GatewayAttachmentReferenceError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409 | 413 = 400) {
    super(message);
    this.name = "GatewayAttachmentReferenceError";
  }
}

function normalizeAttachmentRefs(refs: readonly GatewayAttachmentRefInput[] | undefined): readonly GatewayAttachmentRefInput[] {
  return (refs ?? []).map((ref) => ({
    id: requireGatewayTrimmedString("Gateway attachment id", ref.id),
    ...(ref.sha256 ? {sha256: requireGatewayTrimmedString("Gateway attachment sha256", ref.sha256).toLowerCase()} : {}),
  }));
}

function sameAttachmentRefs(
  expected: readonly GatewayAttachmentRefInput[],
  existing: readonly GatewayEventAttachmentRecord[],
): boolean {
  if (expected.length !== existing.length) {
    return false;
  }

  return expected.every((ref, index) => {
    const attachment = existing[index];
    if (!attachment) {
      return false;
    }
    return attachment.id === ref.id
      && attachment.sha256 === (ref.sha256 ?? attachment.sha256);
  });
}

export function sameIdempotentAttachmentUpload(
  existing: GatewayAttachmentRecord,
  input: Pick<GatewayAttachmentUploadInput, "mimeType" | "sha256"> & {descriptor: {sizeBytes: number}},
): boolean {
  return existing.sha256 === input.sha256
    && existing.sizeBytes === input.descriptor.sizeBytes
    && existing.mimeType === input.mimeType.toLowerCase();
}

function hasTransactionSupport(pool: PgQueryable): pool is PgPoolLike {
  return "connect" in pool && typeof (pool as {connect?: unknown}).connect === "function";
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isPathInsideRoot(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function requireGatewayAttachmentPathWithinMediaRoot(input: {
  agentKey: string;
  env?: NodeJS.ProcessEnv;
  localPath: string;
}): Promise<void> {
  const rootPath = await fs.realpath(resolveAgentMediaDir(input.agentKey, input.env));
  let candidatePath: string;
  try {
    candidatePath = await fs.realpath(input.localPath);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
    candidatePath = path.resolve(input.localPath);
  }

  if (!isPathInsideRoot(rootPath, candidatePath)) {
    throw new Error(`Refusing to scrub gateway attachment outside media root: ${input.localPath}`);
  }
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

  private requireTransactionalPool(): PgPoolLike {
    if (!hasTransactionSupport(this.pool)) {
      throw new Error("Gateway attachment event storage requires a transactional Postgres pool.");
    }
    return this.pool;
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

  private async getDeviceRow(input: {
    sourceId: string;
    deviceId: string;
  }): Promise<Record<string, unknown> | undefined> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.devices}
      WHERE source_id = $1 AND device_id = $2
      LIMIT 1
    `, [
      normalizeGatewaySourceId(input.sourceId),
      normalizeGatewayDeviceId(input.deviceId),
    ]);
    return result.rows[0] as Record<string, unknown> | undefined;
  }

  private async recordDeviceAuditEvent(input: {
    sourceId: string;
    deviceId: string;
    kind: string;
    metadata?: unknown;
  }): Promise<void> {
    await this.pool.query(`
      INSERT INTO ${this.tables.deviceAuditEvents} (
        id,
        source_id,
        device_id,
        kind,
        metadata
      ) VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [
      randomUUID(),
      normalizeGatewaySourceId(input.sourceId),
      normalizeGatewayDeviceId(input.deviceId),
      requireGatewayTrimmedString("Gateway device audit kind", input.kind),
      toJson(parseOptionalGatewayMetadata("Gateway device audit metadata", input.metadata)),
    ]);
  }

  async registerDevice(input: {
    sourceId: string;
    deviceId: string;
    tokenHash: string;
    label?: string;
    capabilities?: readonly GatewayDeviceCapability[];
  }): Promise<GatewayDeviceRecord> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const deviceId = normalizeGatewayDeviceId(input.deviceId);
    const tokenHash = requireGatewayTrimmedString("Gateway device token hash", input.tokenHash);
    const label = input.label?.trim() ? input.label.trim() : undefined;

    const existingRow = await this.getDeviceRow({sourceId, deviceId});
    const existing = existingRow ? parseGatewayDeviceRow(existingRow) : undefined;

    const capabilitiesInsert = input.capabilities ?? existing?.capabilities ?? [];
    const capabilitiesUpdate = input.capabilities;

    const result = await this.pool.query(`
      INSERT INTO ${this.tables.devices} (
        source_id,
        device_id,
        label,
        token_hash,
        capabilities,
        disabled_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, NULL)
      ON CONFLICT (source_id, device_id) DO UPDATE
      SET
        label = COALESCE(EXCLUDED.label, ${this.tables.devices}.label),
        token_hash = EXCLUDED.token_hash,
        capabilities = COALESCE($6::jsonb, ${this.tables.devices}.capabilities),
        disabled_at = NULL,
        updated_at = NOW()
      RETURNING *
    `, [
      sourceId,
      deviceId,
      label ?? null,
      tokenHash,
      toJson(capabilitiesInsert),
      toJson(capabilitiesUpdate),
    ]);

    const device = parseGatewayDeviceRow(result.rows[0] as Record<string, unknown>);
    await this.recordDeviceAuditEvent({
      sourceId,
      deviceId,
      kind: existing ? "device.token_rotated" : "device.registered",
      metadata: {
        ...(label ? {label} : {}),
        ...(input.capabilities ? {capabilities: input.capabilities} : {}),
      },
    });
    return device;
  }

  async listDevices(input: {sourceId: string}): Promise<readonly GatewayDeviceRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.devices}
      WHERE source_id = $1
      ORDER BY device_id ASC
    `, [normalizeGatewaySourceId(input.sourceId)]);
    return result.rows.map((row) => parseGatewayDeviceRow(row as Record<string, unknown>));
  }

  async setDeviceEnabled(input: {
    sourceId: string;
    deviceId: string;
    enabled: boolean;
  }): Promise<GatewayDeviceRecord> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const deviceId = normalizeGatewayDeviceId(input.deviceId);
    const enabled = Boolean(input.enabled);
    const result = await this.pool.query(`
      UPDATE ${this.tables.devices}
      SET
        disabled_at = CASE WHEN $3::boolean THEN NULL ELSE NOW() END,
        updated_at = NOW()
      WHERE source_id = $1
        AND device_id = $2
      RETURNING *
    `, [sourceId, deviceId, enabled]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown gateway device ${deviceId} for source ${sourceId}. Register it first.`);
    }
    const device = parseGatewayDeviceRow(row);
    await this.recordDeviceAuditEvent({
      sourceId,
      deviceId,
      kind: enabled ? "device.enabled" : "device.disabled",
    });
    return device;
  }

  async resolveDeviceToken(token: string): Promise<{
    device: GatewayDeviceRecord;
    source: GatewaySourceRecord;
  } | null> {
    const trimmed = requireGatewayTrimmedString("Device token", token);
    const result = await this.pool.query(`
      SELECT
        source.*,
        device.source_id AS device_source_id,
        device.device_id AS device_device_id,
        device.label AS device_label,
        device.capabilities AS device_capabilities,
        device.disabled_at AS device_disabled_at,
        device.last_seen_at AS device_last_seen_at,
        device.created_at AS device_created_at,
        device.updated_at AS device_updated_at
      FROM ${this.tables.devices} AS device
      JOIN ${this.tables.sources} AS source
        ON source.source_id = device.source_id
      WHERE device.token_hash = $1
        AND source.status = 'active'
        AND device.disabled_at IS NULL
      LIMIT 1
    `, [hashOpaqueToken(trimmed)]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }

    const source = parseGatewaySourceRow(row);
    const device = parseGatewayDeviceRow({
      source_id: (row as {device_source_id?: unknown}).device_source_id,
      device_id: (row as {device_device_id?: unknown}).device_device_id,
      label: (row as {device_label?: unknown}).device_label,
      capabilities: (row as {device_capabilities?: unknown}).device_capabilities,
      disabled_at: (row as {device_disabled_at?: unknown}).device_disabled_at,
      last_seen_at: (row as {device_last_seen_at?: unknown}).device_last_seen_at,
      created_at: (row as {device_created_at?: unknown}).device_created_at,
      updated_at: (row as {device_updated_at?: unknown}).device_updated_at,
    } as Record<string, unknown>);
    return {device, source};
  }

  async touchDeviceSeen(input: {
    sourceId: string;
    deviceId: string;
  }): Promise<void> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const deviceId = normalizeGatewayDeviceId(input.deviceId);
    await this.pool.query(`
      UPDATE ${this.tables.devices}
      SET last_seen_at = NOW(), updated_at = NOW()
      WHERE source_id = $1 AND device_id = $2
    `, [sourceId, deviceId]);
    await this.pool.query(`
      INSERT INTO ${this.tables.deviceAuditEvents} (
        id,
        source_id,
        device_id,
        kind,
        metadata
      )
      SELECT $1, $2, $3, $4, NULL
      WHERE NOT EXISTS (
        SELECT 1
        FROM ${this.tables.deviceAuditEvents}
        WHERE source_id = $2
          AND device_id = $3
          AND kind = $4
          AND created_at > NOW() - INTERVAL '5 minutes'
      )
    `, [
      randomUUID(),
      sourceId,
      deviceId,
      "device.heartbeat",
    ]);
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

  async getAttachment(attachmentId: string): Promise<GatewayAttachmentRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.attachments} WHERE id = $1`,
      [requireGatewayTrimmedString("Gateway attachment id", attachmentId)],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Unknown gateway attachment ${attachmentId}.`);
    }
    return parseGatewayAttachmentRow(row);
  }

  async getAttachmentByIdempotencyKey(
    sourceId: string,
    idempotencyKey: string,
  ): Promise<GatewayAttachmentRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.attachments}
      WHERE source_id = $1 AND idempotency_key = $2
    `, [
      normalizeGatewaySourceId(sourceId),
      requireGatewayTrimmedString("Gateway attachment idempotency key", idempotencyKey),
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseGatewayAttachmentRow(row) : null;
  }

  async countPendingAttachmentsForSource(sourceId: string): Promise<number> {
    const result = await this.pool.query(`
      SELECT COUNT(*)::BIGINT AS count
      FROM ${this.tables.attachments}
      WHERE source_id = $1
        AND status = 'uploaded'
        AND expires_at > NOW()
    `, [normalizeGatewaySourceId(sourceId)]);
    return parseNonNegativeBigintCounter(
      "Gateway pending attachment count",
      (result.rows[0] as {count?: unknown} | undefined)?.count ?? 0,
    );
  }

  async storeAttachmentUpload(input: GatewayAttachmentUploadInput): Promise<GatewayStoredAttachmentResult> {
    try {
      const result = await this.pool.query(`
        INSERT INTO ${this.tables.attachments} (
          id,
          source_id,
          idempotency_key,
          mime_type,
          sniffed_mime_type,
          filename,
          size_bytes,
          sha256,
          local_path,
          media_source,
          connector_key,
          media_metadata,
          created_at,
          expires_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14)
        RETURNING *
      `, [
        requireGatewayTrimmedString("Gateway attachment id", input.descriptor.id),
        normalizeGatewaySourceId(input.sourceId),
        requireGatewayTrimmedString("Gateway attachment idempotency key", input.idempotencyKey),
        requireGatewayTrimmedString("Gateway attachment MIME type", input.mimeType).toLowerCase(),
        input.sniffedMimeType ?? null,
        input.filename ?? null,
        input.descriptor.sizeBytes,
        requireGatewayTrimmedString("Gateway attachment sha256", input.sha256).toLowerCase(),
        requireGatewayTrimmedString("Gateway attachment local path", input.descriptor.localPath),
        requireGatewayTrimmedString("Gateway attachment media source", input.descriptor.source),
        requireGatewayTrimmedString("Gateway attachment connector key", input.descriptor.connectorKey),
        toJson(parseOptionalGatewayMetadata("Gateway attachment media metadata", input.descriptor.metadata)),
        new Date(input.descriptor.createdAt),
        new Date(input.expiresAt),
      ]);
      return {
        attachment: parseGatewayAttachmentRow(result.rows[0] as Record<string, unknown>),
        inserted: true,
      };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      const existing = await this.getAttachmentByIdempotencyKey(input.sourceId, input.idempotencyKey);
      if (!existing || !sameIdempotentAttachmentUpload(existing, input)) {
        throw new GatewayAttachmentConflictError(existing ?? await this.getAttachment(input.descriptor.id));
      }
      return {
        attachment: existing,
        inserted: false,
      };
    }
  }

  private async listEventAttachmentsWithClient(
    client: PgQueryable,
    eventId: string,
  ): Promise<readonly GatewayEventAttachmentRecord[]> {
    const result = await client.query(`
      SELECT
        a.id,
        a.source_id,
        a.idempotency_key,
        a.status,
        a.scan_status,
        ea.mime_type AS mime_type,
        a.sniffed_mime_type,
        a.filename,
        ea.size_bytes AS size_bytes,
        ea.sha256 AS sha256,
        a.local_path,
        a.media_source,
        a.connector_key,
        a.media_metadata,
        a.created_at,
        a.expires_at,
        a.bound_at,
        a.delivered_at,
        a.quarantined_at,
        a.scrubbed_at,
        ea.event_id,
        ea.position
      FROM ${this.tables.eventAttachments} AS ea
      JOIN ${this.tables.attachments} AS a
        ON a.id = ea.attachment_id
      WHERE ea.event_id = $1
      ORDER BY ea.position ASC
    `, [requireGatewayTrimmedString("Gateway event id", eventId)]);
    return result.rows.map((row) => parseGatewayEventAttachmentRow(row as Record<string, unknown>));
  }

  async listEventAttachments(eventId: string): Promise<readonly GatewayEventAttachmentRecord[]> {
    return this.listEventAttachmentsWithClient(this.pool, eventId);
  }

  private async validateAndBindAttachments(input: {
    attachments: readonly GatewayAttachmentRefInput[];
    client: PgQueryable;
    eventId: string;
    maxAttachmentBytes: number;
    sourceId: string;
  }): Promise<void> {
    const seen = new Set<string>();
    const resolved: GatewayAttachmentRecord[] = [];
    for (const ref of input.attachments) {
      if (seen.has(ref.id)) {
        throw new GatewayAttachmentReferenceError("Duplicate attachment refs are not allowed.");
      }
      seen.add(ref.id);
      const result = await input.client.query(
        `SELECT * FROM ${this.tables.attachments} WHERE id = $1`,
        [ref.id],
      );
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        throw new GatewayAttachmentReferenceError("Attachment ref is not available.");
      }
      const attachment = parseGatewayAttachmentRow(row);
      if (attachment.sourceId !== input.sourceId) {
        throw new GatewayAttachmentReferenceError("Attachment ref is not available for this source.");
      }
      if (attachment.expiresAt <= Date.now()) {
        await input.client.query(
          `UPDATE ${this.tables.attachments} SET status = 'expired' WHERE id = $1 AND status = 'uploaded'`,
          [attachment.id],
        );
        throw new GatewayAttachmentReferenceError("Attachment ref has expired.");
      }
      if (attachment.status !== "uploaded") {
        throw new GatewayAttachmentReferenceError("Attachment ref is already bound or unavailable.", 409);
      }
      if (ref.sha256 && attachment.sha256 !== ref.sha256) {
        throw new GatewayAttachmentReferenceError("Attachment ref sha256 does not match.", 409);
      }
      resolved.push(attachment);
    }

    const totalBytes = resolved.reduce((sum, attachment) => sum + attachment.sizeBytes, 0);
    if (totalBytes > input.maxAttachmentBytes) {
      throw new GatewayAttachmentReferenceError("Event attachment bytes exceed the per-event limit.", 413);
    }

    for (const [position, attachment] of resolved.entries()) {
      const updated = await input.client.query(`
        UPDATE ${this.tables.attachments}
        SET status = 'bound', bound_at = NOW()
        WHERE id = $1 AND status = 'uploaded'
        RETURNING *
      `, [attachment.id]);
      if (updated.rows.length === 0) {
        throw new GatewayAttachmentReferenceError("Attachment ref is already bound or unavailable.", 409);
      }
      await input.client.query(`
        INSERT INTO ${this.tables.eventAttachments} (
          event_id,
          attachment_id,
          position,
          sha256,
          size_bytes,
          mime_type
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        input.eventId,
        attachment.id,
        position,
        attachment.sha256,
        attachment.sizeBytes,
        attachment.mimeType,
      ]);
    }
  }

  async storeEventWithAttachments(input: GatewayEventInput & {
    attachments: readonly GatewayAttachmentRefInput[];
    maxAttachmentBytes: number;
  }): Promise<GatewayStoredEventResult> {
    const attachments = normalizeAttachmentRefs(input.attachments);
    const pool = this.requireTransactionalPool();
    return withTransaction(pool, async (client) => {
      const existingResult = await client.query(`
        SELECT *
        FROM ${this.tables.events}
        WHERE source_id = $1 AND idempotency_key = $2
      `, [
        normalizeGatewaySourceId(input.sourceId),
        requireGatewayTrimmedString("Idempotency key", input.idempotencyKey),
      ]);
      const existingRow = existingResult.rows[0] as Record<string, unknown> | undefined;
      if (existingRow) {
        const existing = parseGatewayEventRow(existingRow);
        const existingAttachments = await this.listEventAttachmentsWithClient(client, existing.id);
        if (!sameIdempotentEventBody(existing, input) || !sameAttachmentRefs(attachments, existingAttachments)) {
          throw new GatewayEventConflictError(existing);
        }
        return {
          event: existing,
          inserted: false,
        };
      }

      const id = randomUUID();
      const result = await client.query(`
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
      const event = parseGatewayEventRow(result.rows[0] as Record<string, unknown>);
      await this.validateAndBindAttachments({
        attachments,
        client,
        eventId: event.id,
        maxAttachmentBytes: input.maxAttachmentBytes,
        sourceId: normalizeGatewaySourceId(input.sourceId),
      });
      return {
        event,
        inserted: true,
      };
    });
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
    attachmentRetentionMs?: number;
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
    if (row) {
      const attachmentExpiresAt = new Date(Date.now() + Math.max(
        1,
        Math.floor(input.attachmentRetentionMs ?? DEFAULT_ATTACHMENT_RETENTION_MS),
      ));
      await this.pool.query(`
        UPDATE ${this.tables.attachments}
        SET status = 'delivered',
            delivered_at = COALESCE(delivered_at, NOW()),
            expires_at = $2
        WHERE id IN (
          SELECT attachment_id
          FROM ${this.tables.eventAttachments}
          WHERE event_id = $1
        )
          AND status IN ('bound', 'delivered')
      `, [input.eventId, attachmentExpiresAt]);
    }
    return row ? parseGatewayEventRow(row) : await this.getEvent(input.eventId);
  }

  async markEventQuarantined(input: {
    eventId: string;
    claimId?: string;
    riskScore: number;
    reason: string;
    metadata?: GatewayEventRecord["metadata"];
    attachmentQuarantineTtlMs?: number;
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
    if (row) {
      const attachmentExpiresAt = new Date(Date.now() + Math.max(
        1,
        Math.floor(input.attachmentQuarantineTtlMs ?? DEFAULT_ATTACHMENT_QUARANTINE_TTL_MS),
      ));
      await this.pool.query(`
        UPDATE ${this.tables.attachments}
        SET status = 'quarantined',
            quarantined_at = COALESCE(quarantined_at, NOW()),
            expires_at = $2
        WHERE id IN (
          SELECT attachment_id
          FROM ${this.tables.eventAttachments}
          WHERE event_id = $1
        )
          AND status IN ('uploaded', 'bound', 'quarantined')
      `, [input.eventId, attachmentExpiresAt]);
    }
    return row ? parseGatewayEventRow(row) : await this.getEvent(input.eventId);
  }

  async scrubExpiredAttachments(input: {
    env?: NodeJS.ProcessEnv;
    limit?: number;
    now?: number;
  } = {}): Promise<{scrubbed: number}> {
    const limit = Math.min(500, Math.max(1, Math.floor(input.limit ?? 100)));
    const now = new Date(input.now ?? Date.now());
    const result = await this.pool.query(`
      SELECT a.*, s.agent_key
      FROM ${this.tables.attachments} AS a
      JOIN ${this.tables.sources} AS s
        ON s.source_id = a.source_id
      WHERE a.expires_at <= $1
        AND a.status <> 'scrubbed'
      ORDER BY a.expires_at ASC, a.created_at ASC
      LIMIT $2
    `, [now, limit]);
    const attachments = result.rows.map((row) => ({
      agentKey: requireGatewayTrimmedString("Gateway attachment source agent key", (row as {agent_key?: unknown}).agent_key),
      attachment: parseGatewayAttachmentRow(row as Record<string, unknown>),
    }));
    for (const {agentKey, attachment} of attachments) {
      await requireGatewayAttachmentPathWithinMediaRoot({
        agentKey,
        env: input.env,
        localPath: attachment.localPath,
      });
      await fs.unlink(attachment.localPath).catch((error: unknown) => {
        if (isNotFoundError(error)) {
          return;
        }
        throw error;
      });
      await this.pool.query(`
        UPDATE ${this.tables.attachments}
        SET status = 'scrubbed', scrubbed_at = NOW()
        WHERE id = $1
      `, [attachment.id]);
    }
    return {scrubbed: attachments.length};
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
