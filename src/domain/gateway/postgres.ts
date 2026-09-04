import {randomUUID} from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

import {requireJsonValue, type JsonValue} from "../../lib/json.js";
import {requireNonNegativeInteger} from "../../lib/numbers.js";
import {generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches} from "../../lib/opaque-tokens.js";
import {isUniqueViolation} from "../../lib/postgres-errors.js";
import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {resolveAgentMediaDir} from "../../lib/data-dir.js";
import {toJson} from "../../lib/postgres-values.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {enqueueSessionInputWithClient} from "../threads/runtime/postgres-inputs.js";
import type {ThreadInputPayload} from "../threads/runtime/types.js";
import {buildGatewayDeviceCommandNotificationChannel} from "./device-command-notifications.js";
import {
  gatewayDeviceAllowedCommandKinds,
  normalizeGatewayDeviceId,
  normalizeGatewayEventType,
  normalizeGatewaySourceId,
  parseGatewayAttachmentRow,
  parseGatewayDeliveryMode,
  parseGatewayDeviceCommandKind,
  parseGatewayDeviceCommandRow,
  parseGatewayDeviceCommandStatus,
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
import {buildGatewayTableNames} from "./postgres-shared.js";
import type {
  CreateGatewaySourceInput,
  GatewayAccessTokenRecord,
  GatewayAttachmentRecord,
  GatewayAttachmentRefInput,
  GatewayAttachmentUploadInput,
  GatewayUploadReservation,
  ReserveGatewayUploadInput,
  GatewayDeliveryMode,
  GatewayDeviceCapability,
  GatewayDeviceCommandKind,
  GatewayDeviceCommandClaimResult,
  GatewayDeviceCommandRecord,
  GatewayDeviceCommandStatus,
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

export class GatewayEventPolicyChangedError extends Error {
  constructor() {
    super("Gateway event type policy changed during admission.");
    this.name = "GatewayEventPolicyChangedError";
  }
}

export class GatewayDeliveryTargetUnavailableError extends Error {}

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

export class GatewayUploadAdmissionError extends Error {
  override readonly name = "GatewayUploadAdmissionError";
}

export class GatewayAttachmentReferenceError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409 | 413 = 400) {
    super(message);
    this.name = "GatewayAttachmentReferenceError";
  }
}

export type GatewayDeviceCommandErrorReason = "bad_request" | "conflict" | "forbidden" | "not_found";

export class GatewayDeviceCommandError extends Error {
  constructor(
    readonly reason: GatewayDeviceCommandErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "GatewayDeviceCommandError";
  }
}

function normalizeCommandPayload(value: JsonValue | undefined): JsonValue | undefined {
  return value === undefined ? undefined : requireJsonValue(value, "Gateway device command payload");
}

function normalizeCommandResult(value: JsonValue | undefined): JsonValue | undefined {
  return value === undefined ? undefined : requireJsonValue(value, "Gateway device command result");
}

function normalizeAllowedCommandKinds(
  allowedKinds: readonly GatewayDeviceCommandKind[],
): readonly GatewayDeviceCommandKind[] {
  return [...new Set(allowedKinds.map((kind) => parseGatewayDeviceCommandKind(kind)))];
}

function deviceCommandResultConnectorKey(sourceId: string, deviceId: string): string {
  return `${sourceId}__${deviceId}`;
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
    // A prior unlink may have succeeded before its receipt failed. Resolve the
    // nearest existing parent so symlinked data roots still compare correctly.
    let parent = path.resolve(input.localPath);
    const missing: string[] = [];
    while (true) {
      missing.unshift(path.basename(parent));
      parent = path.dirname(parent);
      try {
        candidatePath = path.join(await fs.realpath(parent), ...missing);
        break;
      } catch (parentError) {
        if (!isNotFoundError(parentError) || parent === path.dirname(parent)) throw parentError;
      }
    }
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

  private requireTransactionalPool(): PgPoolLike {
    if (!hasTransactionSupport(this.pool)) {
      throw new Error("Gateway operation requires a transactional Postgres pool.");
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

  private async getDeviceCommandWithClient(
    client: PgQueryable,
    input: {
      sourceId: string;
      deviceId: string;
      commandId: string;
    },
  ): Promise<GatewayDeviceCommandRecord | null> {
    const result = await client.query(`
      SELECT *
      FROM ${this.tables.commands}
      WHERE source_id = $1
        AND device_id = $2
        AND id = $3
      LIMIT 1
    `, [
      normalizeGatewaySourceId(input.sourceId),
      normalizeGatewayDeviceId(input.deviceId),
      requireGatewayTrimmedString("Gateway device command id", input.commandId),
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseGatewayDeviceCommandRow(row) : null;
  }

  async getDeviceCommand(input: {
    sourceId: string;
    deviceId: string;
    commandId: string;
  }): Promise<GatewayDeviceCommandRecord | null> {
    return this.getDeviceCommandWithClient(this.pool, input);
  }

  private async requireClaimedDeviceCommand(input: {
    allowedKinds: readonly GatewayDeviceCommandKind[];
    client: PgQueryable;
    commandId: string;
    deviceId: string;
    claimId: string;
    sourceId: string;
  }): Promise<GatewayDeviceCommandRecord> {
    const command = await this.getDeviceCommandWithClient(input.client, input);
    if (!command) {
      throw new GatewayDeviceCommandError("not_found", "Gateway device command was not found.");
    }

    const allowedKinds = normalizeAllowedCommandKinds(input.allowedKinds);
    if (!allowedKinds.includes(command.kind)) {
      throw new GatewayDeviceCommandError("forbidden", "Device is no longer allowed to operate this command kind.");
    }

    if (command.status !== "claimed") {
      throw new GatewayDeviceCommandError("conflict", `Gateway device command is ${command.status}, not claimed.`);
    }

    if (command.claimId !== requireGatewayTrimmedString("Gateway device command claim id", input.claimId)) {
      throw new GatewayDeviceCommandError("conflict", "Gateway device command claim id does not match.");
    }

    return command;
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

  async enqueueDeviceCommand(input: {
    sourceId: string;
    deviceId: string;
    kind: GatewayDeviceCommandKind;
    payload?: JsonValue;
  }): Promise<GatewayDeviceCommandRecord> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const deviceId = normalizeGatewayDeviceId(input.deviceId);
    const kind = parseGatewayDeviceCommandKind(input.kind);
    const payload = normalizeCommandPayload(input.payload);
    const deviceRow = await this.getDeviceRow({sourceId, deviceId});
    if (!deviceRow) {
      throw new GatewayDeviceCommandError("not_found", `Unknown gateway device ${deviceId} for source ${sourceId}.`);
    }

    const device = parseGatewayDeviceRow(deviceRow);
    if (!device.enabled) {
      throw new GatewayDeviceCommandError("forbidden", `Gateway device ${deviceId} is disabled.`);
    }

    if (!device.capabilities.includes("claim_commands")) {
      throw new GatewayDeviceCommandError("forbidden", `Gateway device ${deviceId} is missing the claim_commands capability.`);
    }

    if (!gatewayDeviceAllowedCommandKinds(device.capabilities).includes(kind)) {
      throw new GatewayDeviceCommandError("forbidden", `Gateway device ${deviceId} is missing the ${kind} capability.`);
    }

    return withTransaction(this.requireTransactionalPool(), async (client) => {
      const result = await client.query(`
        INSERT INTO ${this.tables.commands} (
          id,
          source_id,
          device_id,
          kind,
          payload
        ) VALUES ($1, $2, $3, $4, $5::jsonb)
        RETURNING *
      `, [
        randomUUID(),
        sourceId,
        deviceId,
        kind,
        toJson(payload),
      ]);
      await client.query("SELECT pg_notify($1, $2)", [
        buildGatewayDeviceCommandNotificationChannel(),
        JSON.stringify({sourceId, deviceId}),
      ]);
      return parseGatewayDeviceCommandRow(result.rows[0] as Record<string, unknown>);
    });
  }

  async listDeviceCommands(input: {
    sourceId: string;
    deviceId?: string;
    status?: GatewayDeviceCommandStatus;
    limit?: number;
  }): Promise<readonly GatewayDeviceCommandRecord[]> {
    const params: unknown[] = [normalizeGatewaySourceId(input.sourceId)];
    const conditions = ["source_id = $1"];
    if (input.deviceId !== undefined) {
      params.push(normalizeGatewayDeviceId(input.deviceId));
      conditions.push(`device_id = $${String(params.length)}`);
    }
    if (input.status !== undefined) {
      params.push(parseGatewayDeviceCommandStatus(input.status));
      conditions.push(`status = $${String(params.length)}`);
    }
    params.push(Math.min(500, Math.max(1, Math.floor(input.limit ?? 50))));
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.commands}
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT $${String(params.length)}
    `, params);
    return result.rows.map((row) => parseGatewayDeviceCommandRow(row as Record<string, unknown>));
  }

  async claimNextDeviceCommand(input: {
    sourceId: string;
    deviceId: string;
    allowedKinds: readonly GatewayDeviceCommandKind[];
  }): Promise<GatewayDeviceCommandClaimResult> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const deviceId = normalizeGatewayDeviceId(input.deviceId);
    const allowedKinds = normalizeAllowedCommandKinds(input.allowedKinds);
    if (allowedKinds.length === 0) {
      return {claimed: false};
    }

    const claimId = randomUUID();
    const kindPlaceholders = allowedKinds.map((_, index) => `$${String(index + 4)}`).join(", ");
    const result = await this.pool.query(`
      UPDATE ${this.tables.commands}
      SET status = 'claimed',
          claim_id = $1,
          claimed_at = NOW(),
          updated_at = NOW()
      WHERE id IN (
        SELECT id
        FROM ${this.tables.commands}
        WHERE source_id = $2
          AND device_id = $3
          AND status = 'queued'
          AND kind IN (${kindPlaceholders})
        ORDER BY created_at ASC
        LIMIT 1
      )
        AND source_id = $2
        AND device_id = $3
        AND status = 'queued'
      RETURNING *
    `, [claimId, sourceId, deviceId, ...allowedKinds]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? {claimed: true, command: parseGatewayDeviceCommandRow(row)} : {claimed: false};
  }

  async heartbeatDeviceCommand(input: {
    sourceId: string;
    deviceId: string;
    commandId: string;
    claimId: string;
    allowedKinds: readonly GatewayDeviceCommandKind[];
  }): Promise<GatewayDeviceCommandRecord> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const deviceId = normalizeGatewayDeviceId(input.deviceId);
    const commandId = requireGatewayTrimmedString("Gateway device command id", input.commandId);
    const claimId = requireGatewayTrimmedString("Gateway device command claim id", input.claimId);
    const allowedKinds = normalizeAllowedCommandKinds(input.allowedKinds);
    await this.requireClaimedDeviceCommand({
      allowedKinds,
      client: this.pool,
      commandId,
      deviceId,
      claimId,
      sourceId,
    });
    const result = await this.pool.query(`
      UPDATE ${this.tables.commands}
      SET updated_at = NOW()
      WHERE id = $1
        AND source_id = $2
        AND device_id = $3
        AND claim_id = $4
        AND status = 'claimed'
        AND kind IN (${allowedKinds.map((_, index) => `$${String(index + 5)}`).join(", ")})
      RETURNING *
    `, [commandId, sourceId, deviceId, claimId, ...allowedKinds]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new GatewayDeviceCommandError("conflict", "Gateway device command heartbeat conflicted with a lifecycle update.");
    }
    return parseGatewayDeviceCommandRow(row);
  }

  private async validateAndDeliverCommandResultAttachment(input: {
    attachmentId: string;
    attachmentRetentionMs?: number;
    client: PgQueryable;
    deviceId: string;
    sourceId: string;
  }): Promise<void> {
    const attachmentId = requireGatewayTrimmedString("Gateway command result attachment id", input.attachmentId);
    const result = await input.client.query(
      `SELECT * FROM ${this.tables.attachments} WHERE id = $1 LIMIT 1`,
      [attachmentId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new GatewayDeviceCommandError("conflict", "Command result attachment is not available.");
    }

    const attachment = parseGatewayAttachmentRow(row);
    if (attachment.sourceId !== input.sourceId) {
      throw new GatewayDeviceCommandError("conflict", "Command result attachment is not available for this source.");
    }
    if (attachment.connectorKey !== deviceCommandResultConnectorKey(input.sourceId, input.deviceId)) {
      throw new GatewayDeviceCommandError("conflict", "Command result attachment was not uploaded by this device.");
    }
    if (attachment.expiresAt <= Date.now()) {
      await input.client.query(
        `UPDATE ${this.tables.attachments} SET status = 'expired' WHERE id = $1 AND status = 'uploaded'`,
        [attachment.id],
      );
      throw new GatewayDeviceCommandError("conflict", "Command result attachment has expired.");
    }
    if (attachment.status !== "uploaded") {
      throw new GatewayDeviceCommandError("conflict", "Command result attachment is already bound or unavailable.");
    }

    const attachmentExpiresAt = new Date(Date.now() + Math.max(
      1,
      Math.floor(input.attachmentRetentionMs ?? DEFAULT_ATTACHMENT_RETENTION_MS),
    ));
    const updated = await input.client.query(`
      UPDATE ${this.tables.attachments}
      SET status = 'delivered',
          delivered_at = COALESCE(delivered_at, NOW()),
          expires_at = $2
      WHERE id = $1
        AND status = 'uploaded'
      RETURNING *
    `, [attachment.id, attachmentExpiresAt]);
    if (updated.rows.length === 0) {
      throw new GatewayDeviceCommandError("conflict", "Command result attachment is already bound or unavailable.");
    }
  }

  async completeDeviceCommand(input: {
    sourceId: string;
    deviceId: string;
    commandId: string;
    claimId: string;
    allowedKinds: readonly GatewayDeviceCommandKind[];
    result?: JsonValue;
    resultAttachmentId?: string;
    attachmentRetentionMs?: number;
  }): Promise<GatewayDeviceCommandRecord> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const deviceId = normalizeGatewayDeviceId(input.deviceId);
    const commandId = requireGatewayTrimmedString("Gateway device command id", input.commandId);
    const claimId = requireGatewayTrimmedString("Gateway device command claim id", input.claimId);
    const allowedKinds = normalizeAllowedCommandKinds(input.allowedKinds);
    const resultJson = normalizeCommandResult(input.result);
    const resultAttachmentId = input.resultAttachmentId === undefined
      ? undefined
      : requireGatewayTrimmedString("Gateway command result attachment id", input.resultAttachmentId);

    const completeWithClient = async (client: PgQueryable): Promise<GatewayDeviceCommandRecord> => {
      await this.requireClaimedDeviceCommand({
        allowedKinds,
        client,
        commandId,
        deviceId,
        claimId,
        sourceId,
      });
      if (resultAttachmentId) {
        await this.validateAndDeliverCommandResultAttachment({
          attachmentId: resultAttachmentId,
          attachmentRetentionMs: input.attachmentRetentionMs,
          client,
          deviceId,
          sourceId,
        });
      }
      const update = await client.query(`
        UPDATE ${this.tables.commands}
        SET status = 'completed',
            completed_at = NOW(),
            updated_at = NOW(),
            result = $5::jsonb,
            result_attachment_id = $6
        WHERE id = $1
          AND source_id = $2
          AND device_id = $3
          AND claim_id = $4
          AND status = 'claimed'
          AND kind IN (${allowedKinds.map((_, index) => `$${String(index + 7)}`).join(", ")})
        RETURNING *
      `, [commandId, sourceId, deviceId, claimId, toJson(resultJson), resultAttachmentId ?? null, ...allowedKinds]);
      const row = update.rows[0] as Record<string, unknown> | undefined;
      if (!row) {
        throw new GatewayDeviceCommandError("conflict", "Gateway device command completion conflicted with a lifecycle update.");
      }
      return parseGatewayDeviceCommandRow(row);
    };

    if (resultAttachmentId) {
      return withTransaction(this.requireTransactionalPool(), completeWithClient);
    }
    return completeWithClient(this.pool);
  }

  async failDeviceCommand(input: {
    sourceId: string;
    deviceId: string;
    commandId: string;
    claimId: string;
    allowedKinds: readonly GatewayDeviceCommandKind[];
    status: Extract<GatewayDeviceCommandStatus, "failed" | "rejected">;
    error: string;
  }): Promise<GatewayDeviceCommandRecord> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const deviceId = normalizeGatewayDeviceId(input.deviceId);
    const commandId = requireGatewayTrimmedString("Gateway device command id", input.commandId);
    const claimId = requireGatewayTrimmedString("Gateway device command claim id", input.claimId);
    const allowedKinds = normalizeAllowedCommandKinds(input.allowedKinds);
    const status = input.status === "rejected" ? "rejected" : "failed";
    await this.requireClaimedDeviceCommand({
      allowedKinds,
      client: this.pool,
      commandId,
      deviceId,
      claimId,
      sourceId,
    });
    const update = await this.pool.query(`
      UPDATE ${this.tables.commands}
      SET status = $5,
          error = $6,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND source_id = $2
        AND device_id = $3
        AND claim_id = $4
        AND status = 'claimed'
        AND kind IN (${allowedKinds.map((_, index) => `$${String(index + 7)}`).join(", ")})
      RETURNING *
    `, [
      commandId,
      sourceId,
      deviceId,
      claimId,
      status,
      requireGatewayTrimmedString("Gateway device command error", input.error),
      ...allowedKinds,
    ]);
    const row = update.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new GatewayDeviceCommandError("conflict", "Gateway device command failure conflicted with a lifecycle update.");
    }
    return parseGatewayDeviceCommandRow(row);
  }

  async cancelQueuedDeviceCommand(input: {
    sourceId: string;
    deviceId: string;
    commandId: string;
    reason?: string;
  }): Promise<GatewayDeviceCommandRecord> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const deviceId = normalizeGatewayDeviceId(input.deviceId);
    const commandId = requireGatewayTrimmedString("Gateway device command id", input.commandId);
    const result = await this.pool.query(`
      UPDATE ${this.tables.commands}
      SET status = 'cancelled',
          error = $4,
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
        AND source_id = $2
        AND device_id = $3
        AND status = 'queued'
      RETURNING *
    `, [
      commandId,
      sourceId,
      deviceId,
      input.reason?.trim() ? input.reason.trim() : "Cancelled by admin.",
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (row) {
      return parseGatewayDeviceCommandRow(row);
    }

    const existing = await this.getDeviceCommand({sourceId, deviceId, commandId});
    if (!existing) {
      throw new GatewayDeviceCommandError("not_found", "Gateway device command was not found.");
    }
    throw new GatewayDeviceCommandError("conflict", `Gateway device command is ${existing.status}, not queued.`);
  }

  async markStaleClaimedDeviceCommandsTimedOut(input: {
    sourceId?: string;
    staleMs: number;
    limit?: number;
  }): Promise<readonly GatewayDeviceCommandRecord[]> {
    const staleBefore = new Date(Date.now() - Math.max(1, Math.floor(input.staleMs)));
    const limit = Math.min(500, Math.max(1, Math.floor(input.limit ?? 100)));
    const params: unknown[] = [staleBefore, limit];
    const sourceFilter = input.sourceId ? "AND source_id = $3" : "";
    if (input.sourceId) {
      params.push(normalizeGatewaySourceId(input.sourceId));
    }
    const result = await this.pool.query(`
      UPDATE ${this.tables.commands}
      SET status = 'timed_out',
          error = 'Command timed out after stale claim sweep.',
          completed_at = NOW(),
          updated_at = NOW()
      WHERE id IN (
        SELECT id
        FROM ${this.tables.commands}
        WHERE status = 'claimed'
          AND updated_at < $1
          ${sourceFilter}
        ORDER BY updated_at ASC, created_at ASC
        LIMIT $2
      )
        AND status = 'claimed'
      RETURNING *
    `, params);
    return result.rows.map((row) => parseGatewayDeviceCommandRow(row as Record<string, unknown>));
  }

  async upsertEventType(input: {
    sourceId: string;
    type: string;
    delivery: GatewayDeliveryMode;
    trusted: boolean;
  }): Promise<GatewayEventTypeRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.eventTypes} (
        source_id,
        event_type,
        delivery,
        trusted
      ) VALUES ($1, $2, $3, $4)
      ON CONFLICT (source_id, event_type)
      DO UPDATE SET
        delivery = EXCLUDED.delivery,
        trusted = EXCLUDED.trusted,
        updated_at = NOW()
      RETURNING *
    `, [
      normalizeGatewaySourceId(input.sourceId),
      normalizeGatewayEventType(input.type),
      parseGatewayDeliveryMode(input.delivery),
      input.trusted === true,
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

  async deleteEventType(sourceId: string, type: string): Promise<boolean> {
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.eventTypes}
      WHERE source_id = $1 AND event_type = $2
      RETURNING event_type
    `, [
      normalizeGatewaySourceId(sourceId),
      normalizeGatewayEventType(type),
    ]);
    return result.rows.length > 0;
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

  private async insertEventWithCurrentPolicy(
    client: PgQueryable,
    input: GatewayEventInput,
  ): Promise<GatewayEventRecord> {
    const id = randomUUID();
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const eventType = normalizeGatewayEventType(input.type);
    const deliveryRequested = parseGatewayDeliveryMode(input.deliveryRequested);
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
        text_sha256,
        trusted
      )
      SELECT
        $1::text,
        $2::text,
        $3::text,
        $4::text,
        CASE WHEN policy.delivery = 'queue' THEN 'queue' ELSE $4::text END,
        $5::timestamptz,
        $6::text,
        $7::text,
        $8::integer,
        $9::text,
        policy.trusted
      FROM ${this.tables.eventTypes} AS policy
      WHERE policy.source_id = $2
        AND policy.event_type = $3
      RETURNING *
    `, [
      id,
      sourceId,
      eventType,
      deliveryRequested,
      input.occurredAt === undefined ? null : new Date(input.occurredAt),
      requireGatewayTrimmedString("Idempotency key", input.idempotencyKey),
      input.text,
      input.textBytes,
      input.textSha256,
    ]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new GatewayEventPolicyChangedError();
    }
    return parseGatewayEventRow(row);
  }

  async storeEvent(input: GatewayEventInput): Promise<GatewayStoredEventResult> {
    try {
      return {
        event: await this.insertEventWithCurrentPolicy(this.pool, input),
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
    return this.storeAttachmentUploadWithClient(this.pool, input);
  }

  private async storeAttachmentUploadWithClient(client: PgQueryable, input: GatewayAttachmentUploadInput): Promise<GatewayStoredAttachmentResult> {
    const sourceId = normalizeGatewaySourceId(input.sourceId);
    const idempotencyKey = requireGatewayTrimmedString("Gateway attachment idempotency key", input.idempotencyKey);
    const id = requireGatewayTrimmedString("Gateway attachment id", input.descriptor.id);
    const result = await client.query(`
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
      ON CONFLICT DO NOTHING
      RETURNING *
    `, [
      id,
      sourceId,
      idempotencyKey,
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
    if (result.rows[0]) return {
      attachment: parseGatewayAttachmentRow(result.rows[0] as Record<string, unknown>),
      inserted: true,
    };
    const duplicate = await client.query(`SELECT * FROM ${this.tables.attachments} WHERE (source_id = $1 AND idempotency_key = $2) OR id = $3`, [sourceId, idempotencyKey, id]);
    const existing = duplicate.rows[0] ? parseGatewayAttachmentRow(duplicate.rows[0] as Record<string, unknown>) : null;
    if (!existing || existing.sourceId !== sourceId || existing.idempotencyKey !== idempotencyKey || !sameIdempotentAttachmentUpload(existing, input)) {
      if (!existing) throw new Error("Conflicting gateway attachment disappeared.");
      throw new GatewayAttachmentConflictError(existing);
    }
    return {
      attachment: existing,
      inserted: false,
    };
  }

  private async lockUploadAdmission(client: PgQueryable): Promise<void> {
    // Serialize pending/receiving transitions as well as admission; no lock spans body IO.
    await client.query(`
      INSERT INTO ${this.tables.rateLimits} (bucket_key, window_start, used)
      VALUES ('gateway:attachment:admission', NOW(), 0)
      ON CONFLICT (bucket_key) DO UPDATE SET updated_at = NOW()
    `);
  }

  async reserveAttachmentUpload(input: ReserveGatewayUploadInput): Promise<GatewayUploadReservation> {
    return withTransaction(this.requireTransactionalPool(), async (client) => {
      await this.lockUploadAdmission(client);
      const deadline = await client.query("SELECT clock_timestamp() < $1::timestamptz AS live", [new Date(input.expiresAt)]);
      if (!(deadline.rows[0] as {live: boolean}).live) throw new GatewayUploadAdmissionError("Attachment upload deadline exceeded.");
      const active = await client.query(`SELECT COUNT(*) AS count FROM ${this.tables.uploadReservations} WHERE status = 'receiving' AND expires_at > clock_timestamp()`);
      if (Number((active.rows[0] as {count: string}).count) >= input.maxConcurrent) throw new GatewayUploadAdmissionError("Concurrent attachment validation limit exceeded.");
      const found = await client.query(`SELECT id FROM ${this.tables.attachments} WHERE source_id = $1 AND idempotency_key = $2`, [input.sourceId, input.idempotencyKey]);
      const isRetry = Boolean(found.rows[0]);
      if (!isRetry) {
        const receiving = await client.query(`SELECT idempotency_key FROM ${this.tables.uploadReservations} WHERE source_id = $1 AND status = 'receiving' AND expires_at > clock_timestamp() AND is_retry = FALSE`, [input.sourceId]);
        if (receiving.rows.some((row) => (row as {idempotency_key: string}).idempotency_key === input.idempotencyKey)) throw new GatewayUploadAdmissionError("This attachment upload is already in progress.");
        const pending = await client.query(`SELECT COUNT(*) AS count FROM ${this.tables.attachments} WHERE source_id = $1 AND status = 'uploaded' AND expires_at > clock_timestamp()`, [input.sourceId]);
        if (Number((pending.rows[0] as {count: string}).count) + receiving.rows.length >= input.maxPending) throw new GatewayUploadAdmissionError("Pending attachment limit exceeded.");
        const quota = await client.query(`
          INSERT INTO ${this.tables.rateLimits} (bucket_key, window_start, used)
          VALUES ($1, clock_timestamp(), $2)
          ON CONFLICT (bucket_key) DO UPDATE SET
            window_start = CASE WHEN ${this.tables.rateLimits}.window_start < clock_timestamp() - INTERVAL '1 hour' THEN clock_timestamp() ELSE ${this.tables.rateLimits}.window_start END,
            used = CASE WHEN ${this.tables.rateLimits}.window_start < clock_timestamp() - INTERVAL '1 hour' THEN EXCLUDED.used ELSE ${this.tables.rateLimits}.used + EXCLUDED.used END,
            updated_at = clock_timestamp()
          RETURNING used
        `, [`gateway:source:${input.sourceId}:attachment_bytes`, input.reservedBytes]);
        if (Number((quota.rows[0] as {used: string}).used) > input.byteLimit) throw new GatewayUploadAdmissionError("Attachment byte budget exceeded.");
      }
      const inserted = await client.query(`
        INSERT INTO ${this.tables.uploadReservations}
          (id, source_id, idempotency_key, directory, is_retry, reserved_bytes, quota_window_start, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6,
          (SELECT window_start FROM ${this.tables.rateLimits} WHERE bucket_key = $7),
          $8::timestamptz)
        RETURNING EXTRACT(EPOCH FROM expires_at) * 1000 AS expires_at_ms
      `, [input.id, input.sourceId, input.idempotencyKey, input.directory, isRetry, isRetry ? 0 : input.reservedBytes,
        `gateway:source:${input.sourceId}:attachment_bytes`, new Date(input.expiresAt)]);
      const expiresAt = Number((inserted.rows[0] as {expires_at_ms: string}).expires_at_ms);
      return {id: input.id, sourceId: input.sourceId, directory: input.directory, expiresAt};
    });
  }

  async completeAttachmentUpload(reservationId: string, input: GatewayAttachmentUploadInput): Promise<GatewayStoredAttachmentResult> {
    return withTransaction(this.requireTransactionalPool(), async (client) => {
      await this.lockUploadAdmission(client);
      const selected = await client.query(`SELECT *, expires_at > clock_timestamp() AS live FROM ${this.tables.uploadReservations} WHERE id = $1 FOR UPDATE`, [reservationId]);
      const reservation = selected.rows[0] as Record<string, unknown> | undefined;
      if (!reservation || reservation.source_id !== input.sourceId || reservation.idempotency_key !== input.idempotencyKey) throw new Error("Attachment reservation is unavailable.");
      if (reservation.status !== "committed" && (reservation.status !== "receiving" || !reservation.live)) throw new Error("Attachment reservation expired or was revoked.");
      if (path.dirname(input.descriptor.localPath) !== reservation.directory || input.descriptor.id !== reservationId) throw new Error("Attachment descriptor does not belong to its reservation.");
      let stored: GatewayStoredAttachmentResult;
      if (reservation.is_retry || reservation.status === "committed") {
        const selectedAttachment = await client.query(`SELECT * FROM ${this.tables.attachments} WHERE source_id = $1 AND idempotency_key = $2`, [input.sourceId, input.idempotencyKey]);
        const existing = selectedAttachment.rows[0] ? parseGatewayAttachmentRow(selectedAttachment.rows[0] as Record<string, unknown>) : null;
        if (!existing) throw new Error("Previously accepted attachment is unavailable.");
        if (!sameIdempotentAttachmentUpload(existing, input)) throw new GatewayAttachmentConflictError(existing);
        stored = {attachment: existing, inserted: false};
      } else {
        if (input.descriptor.sizeBytes > Number(reservation.reserved_bytes)) throw new Error("Attachment exceeds its byte reservation.");
        stored = await this.storeAttachmentUploadWithClient(client, input);
      }
      if (reservation.status !== "committed" && !reservation.is_retry) {
        await client.query(`
          UPDATE ${this.tables.rateLimits} SET used = GREATEST(0, used - $2::bigint), updated_at = NOW()
          WHERE bucket_key = $1 AND window_start = (SELECT quota_window_start FROM ${this.tables.uploadReservations} WHERE id = $3)
        `, [`gateway:source:${input.sourceId}:attachment_bytes`, Number(reservation.reserved_bytes) - input.descriptor.sizeBytes, reservationId]);
      }
      await client.query(`UPDATE ${this.tables.uploadReservations} SET status = 'committed' WHERE id = $1`, [reservationId]);
      return stored;
    });
  }

  async discardAttachmentUpload(input: {id: string; directory: string; sourceId: string; expiresAt?: number; expiredOnly?: boolean}): Promise<"discard" | "retained" | "active" | "mismatch"> {
    return withTransaction(this.requireTransactionalPool(), async (client) => {
      await this.lockUploadAdmission(client);
      const selected = await client.query(`SELECT *, expires_at <= clock_timestamp() AS expired FROM ${this.tables.uploadReservations} WHERE id = $1 FOR UPDATE`, [input.id]);
      const reservation = selected.rows[0] as Record<string, unknown> | undefined;
      if (reservation && (reservation.source_id !== input.sourceId || reservation.directory !== input.directory)) return "mismatch";
      // The attachment row is the durable file receipt, including delivered/scrubbed history.
      const committed = await client.query(`SELECT id FROM ${this.tables.attachments} WHERE id = $1`, [input.id]);
      if (committed.rows[0]) return "retained";
      if (!reservation && input.expiredOnly) {
        if (input.expiresAt === undefined) return "active";
        // An absent-row proof is safe only once the immutable admission deadline has passed.
        const deadline = await client.query("SELECT clock_timestamp() >= $1::timestamptz AS expired", [new Date(input.expiresAt)]);
        if (!(deadline.rows[0] as {expired: boolean}).expired) return "active";
      }
      if (reservation?.status === "receiving" && input.expiredOnly && !reservation.expired) return "active";
      if (reservation) await client.query(`UPDATE ${this.tables.uploadReservations} SET status = 'aborted' WHERE id = $1`, [input.id]);
      return "discard";
    });
  }

  async removeAttachmentUploadReservation(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.tables.uploadReservations} WHERE id = $1 AND status <> 'receiving'`, [id]);
  }

  async removeExpiredAttachmentUploadReservations(limit: number): Promise<void> {
    await withTransaction(this.requireTransactionalPool(), async (client) => {
      await this.lockUploadAdmission(client);
      await client.query(`DELETE FROM ${this.tables.uploadReservations} WHERE id IN (
        SELECT id FROM ${this.tables.uploadReservations} WHERE expires_at <= clock_timestamp() ORDER BY expires_at LIMIT $1
      )`, [limit]);
    });
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

      const sourceId = normalizeGatewaySourceId(input.sourceId);
      const event = await this.insertEventWithCurrentPolicy(client, input);
      await this.validateAndBindAttachments({
        attachments,
        client,
        eventId: event.id,
        maxAttachmentBytes: input.maxAttachmentBytes,
        sourceId,
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

  async recordEventAssessment(input: {
    eventId: string;
    claimId: string;
    riskScore?: number;
    metadata: GatewayEventRecord["metadata"];
  }): Promise<GatewayEventRecord | null> {
    const metadata = toJson(parseOptionalGatewayMetadata("Gateway event metadata", input.metadata));
    const result = await this.pool.query(`
      UPDATE ${this.tables.events}
      SET input_id = COALESCE(input_id, $3::uuid),
          risk_score = CASE WHEN input_id IS NULL THEN $4 ELSE risk_score END,
          metadata = CASE WHEN input_id IS NULL THEN $5::jsonb ELSE metadata END
      WHERE id = $1 AND claim_id = $2 AND status = 'processing'
      RETURNING *
    `, [input.eventId, input.claimId, randomUUID(), input.riskScore ?? null, metadata]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseGatewayEventRow(row) : null;
  }

  /** Accept one guarded event, its input and attachment receipts in one commit. */
  async commitEventDelivery(input: {
    eventId: string;
    claimId: string;
    source: Pick<GatewaySourceRecord, "sourceId" | "agentKey" | "identityId" | "sessionId">;
    payload: ThreadInputPayload;
    attachmentRetentionMs?: number;
  }): Promise<GatewayEventRecord | null> {
    return withTransaction(this.requireTransactionalPool(), async (client) => {
      const receipt = await client.query(`SELECT * FROM ${this.tables.events} WHERE id = $1`, [input.eventId]);
      const existing = receipt.rows[0] as Record<string, unknown> | undefined;
      if (!existing) return null;
      if (existing.status === "delivered") return parseGatewayEventRow(existing);
      // Archive and reset take the session lock first. Source/event locks must
      // follow it, or their cascade updates can deadlock delivery admission.
      const target = await client.query(`
        SELECT id, archived_at FROM ${this.sessionTables.sessions}
        WHERE agent_key = $1 AND (
          ($2::text IS NOT NULL AND id = $2) OR ($2::text IS NULL AND kind = 'main')
        )
        FOR UPDATE
      `, [input.source.agentKey, input.source.sessionId ?? null]);
      const session = target.rows[0] as {id: string; archived_at: unknown} | undefined;
      if (!session || session.archived_at !== null) {
        throw new GatewayDeliveryTargetUnavailableError("Gateway target session is missing or archived.");
      }
      const sourceResult = await client.query(`
        SELECT * FROM ${this.tables.sources} WHERE source_id = $1 FOR UPDATE
      `, [input.source.sourceId]);
      const sourceRow = sourceResult.rows[0] as Record<string, unknown> | undefined;
      if (!sourceRow) throw new GatewayDeliveryTargetUnavailableError("Gateway source no longer exists.");
      const source = parseGatewaySourceRow(sourceRow);
      if (source.status !== "active" || source.agentKey !== input.source.agentKey
        || source.identityId !== input.source.identityId || source.sessionId !== input.source.sessionId) {
        throw new GatewayDeliveryTargetUnavailableError("Gateway source authority changed before delivery.");
      }
      const result = await client.query(`SELECT * FROM ${this.tables.events} WHERE id = $1 FOR UPDATE`, [input.eventId]);
      const row = result.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      const event = parseGatewayEventRow(row);
      if (event.status === "delivered") return event;
      if (event.status !== "processing" || event.claimId !== input.claimId) return null;
      if (event.sourceId !== source.sourceId || !event.inputId) {
        throw new Error("Gateway delivery requires an owned, guarded input receipt.");
      }
      await client.query(`
        SELECT attachment.id FROM ${this.tables.attachments} AS attachment
        JOIN ${this.tables.eventAttachments} AS link ON link.attachment_id = attachment.id
        WHERE link.event_id = $1 ORDER BY attachment.id FOR UPDATE OF attachment
      `, [event.id]);
      const unavailable = await client.query(`
        SELECT attachment.id FROM ${this.tables.attachments} AS attachment
        JOIN ${this.tables.eventAttachments} AS link ON link.attachment_id = attachment.id
        WHERE link.event_id = $1
          AND (attachment.status <> 'bound' OR attachment.expires_at <= clock_timestamp())
      `, [event.id]);
      if (unavailable.rows.length > 0) {
        throw new GatewayDeliveryTargetUnavailableError("Gateway attachment expired or became unavailable before delivery.");
      }
      const accepted = await enqueueSessionInputWithClient(client, session.id, {
        ...input.payload,
        source: "gateway",
        channelId: event.sourceId,
        externalMessageId: event.id,
        actorId: event.sourceId,
        identityId: source.identityId,
        metadata: event.metadata,
      }, event.deliveryEffective, {inputId: event.inputId});
      const delivered = await client.query(`
        UPDATE ${this.tables.events}
        SET status = 'delivered', thread_id = $2, text = '',
            processed_at = NOW(), delivered_at = NOW(),
            text_scrubbed_at = COALESCE(text_scrubbed_at, NOW())
        WHERE id = $1
        RETURNING *
      `, [event.id, accepted.input.threadId]);
      await client.query(`
        UPDATE ${this.tables.attachments}
        SET status = 'delivered', delivered_at = COALESCE(delivered_at, NOW()),
            expires_at = NOW() + ($2::double precision * INTERVAL '1 millisecond')
        WHERE id IN (SELECT attachment_id FROM ${this.tables.eventAttachments} WHERE event_id = $1)
          AND status IN ('bound', 'delivered')
      `, [event.id, Math.max(1, Math.floor(input.attachmentRetentionMs ?? DEFAULT_ATTACHMENT_RETENTION_MS))]);
      return parseGatewayEventRow(delivered.rows[0] as Record<string, unknown>);
    });
  }

  async markEventQuarantined(input: {
    eventId: string;
    claimId?: string;
    riskScore?: number;
    reason: string;
    metadata?: GatewayEventRecord["metadata"];
    attachmentQuarantineTtlMs?: number;
  }): Promise<GatewayEventRecord> {
    return withTransaction(this.requireTransactionalPool(), async (client) => {
      const result = await client.query(`
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
        input.riskScore ?? null,
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
        await client.query(`
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
      if (row) return parseGatewayEventRow(row);
      const current = await client.query(`SELECT * FROM ${this.tables.events} WHERE id = $1`, [input.eventId]);
      if (!current.rows[0]) throw new Error(`Unknown gateway event ${input.eventId}.`);
      return parseGatewayEventRow(current.rows[0] as Record<string, unknown>);
    });
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
    let scrubbed = 0;
    for (const candidate of result.rows as Record<string, unknown>[]) {
      const removed = await withTransaction(this.requireTransactionalPool(), async (client) => {
        const locked = await client.query(`
          SELECT a.*, s.agent_key FROM ${this.tables.attachments} AS a
          JOIN ${this.tables.sources} AS s ON s.source_id = a.source_id
          WHERE a.id = $1 FOR UPDATE OF a
        `, [candidate.id]);
        const row = locked.rows[0] as Record<string, unknown> | undefined;
        if (!row) return false;
        const attachment = parseGatewayAttachmentRow(row);
        // Delivery may have extended retention while this sweep waited. Keep
        // the row locked through unlink, so admission can never race cleanup.
        const expired = await client.query(`
          SELECT id FROM ${this.tables.attachments} WHERE id = $1
            AND status <> 'scrubbed' AND expires_at <= ${input.now === undefined ? "clock_timestamp()" : "$2::timestamptz"}
        `, input.now === undefined ? [attachment.id] : [attachment.id, now]);
        if (expired.rows.length === 0) return false;
        await requireGatewayAttachmentPathWithinMediaRoot({
          agentKey: requireGatewayTrimmedString("Gateway attachment source agent key", row.agent_key),
          env: input.env, localPath: attachment.localPath,
        });
        await fs.unlink(attachment.localPath).catch((error: unknown) => {
          if (!isNotFoundError(error)) throw error;
        });
        await client.query(`
          UPDATE ${this.tables.attachments} SET status = 'scrubbed', scrubbed_at = NOW() WHERE id = $1
        `, [attachment.id]);
        return true;
      });
      if (removed) scrubbed += 1;
    }
    return {scrubbed};
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
