import {randomUUID} from "node:crypto";

import type {PgPoolLike} from "../../lib/postgres-query.js";
import {
  ensurePostgresConnectorLeaseSchema,
  POSTGRES_CONNECTOR_LEASE_TABLE,
} from "./postgres-schema.js";
import {requireTimestampMillis} from "../../lib/postgres-values.js";
import {requireNonEmptyString} from "../../lib/strings.js";

export interface ConnectorLeaseLookup {
  source: string;
  connectorKey: string;
}

export interface ConnectorLeaseRecord extends ConnectorLeaseLookup {
  holderId: string;
  leasedUntil: number;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectorLeaseMutationInput extends ConnectorLeaseLookup {
  holderId: string;
  leasedUntil: number;
}

export interface PostgresConnectorLeaseRepoOptions {
  pool: PgPoolLike;
}

export interface ManagedConnectorLease {
  release(): Promise<void>;
}

export interface ConnectorLeaseRepository {
  tryAcquire(input: ConnectorLeaseMutationInput): Promise<ConnectorLeaseRecord | null>;
  renew(input: ConnectorLeaseMutationInput): Promise<ConnectorLeaseRecord | null>;
  release(input: ConnectorLeaseLookup & {holderId: string}): Promise<boolean>;
}

export interface AcquireManagedConnectorLeaseOptions {
  repo: ConnectorLeaseRepository;
  source: string;
  connectorKey: string;
  alreadyHeldMessage: string;
  holderId?: string;
  ttlMs?: number;
  renewIntervalMs?: number;
  onError?: (error: unknown) => Promise<void> | void;
  onLeaseLost?: (error: Error) => Promise<void> | void;
}

const DEFAULT_CONNECTOR_LEASE_TTL_MS = 30_000;
const DEFAULT_CONNECTOR_LEASE_RENEW_INTERVAL_MS = 10_000;

function requireConnectorLeaseString(field: string, value: unknown): string {
  return requireNonEmptyString(value, `Connector lease ${field} must not be empty.`);
}

function requirePositiveInteger(field: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Connector lease ${field} must be a positive integer.`);
  }

  return value;
}

function normalizeLookup(input: ConnectorLeaseLookup): ConnectorLeaseLookup {
  return {
    source: requireConnectorLeaseString("source", input.source),
    connectorKey: requireConnectorLeaseString("connector key", input.connectorKey),
  };
}

function normalizeMutation(input: ConnectorLeaseMutationInput): ConnectorLeaseMutationInput {
  const lookup = normalizeLookup(input);
  return {
    ...lookup,
    holderId: requireConnectorLeaseString("holder id", input.holderId),
    leasedUntil: requirePositiveInteger("leasedUntil", input.leasedUntil),
  };
}

function parseRecord(row: Record<string, unknown>): ConnectorLeaseRecord {
  return {
    source: requireConnectorLeaseString("source", row.source),
    connectorKey: requireConnectorLeaseString("connector key", row.connector_key),
    holderId: requireConnectorLeaseString("holder id", row.holder_id),
    leasedUntil: requireTimestampMillis(row.leased_until, "Connector lease leasedUntil must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "Connector lease createdAt must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Connector lease updatedAt must be a valid timestamp."),
  };
}

function toTimestamp(value: number): Date {
  return new Date(value);
}

export class PostgresConnectorLeaseRepo {
  private readonly pool: PgPoolLike;
  private readonly tableName = POSTGRES_CONNECTOR_LEASE_TABLE;

  constructor(options: PostgresConnectorLeaseRepoOptions) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresConnectorLeaseSchema(this.pool);
  }

  async tryAcquire(input: ConnectorLeaseMutationInput): Promise<ConnectorLeaseRecord | null> {
    const normalized = normalizeMutation(input);
    const client = await this.pool.connect();
    let inTransaction = false;

    try {
      await client.query("BEGIN");
      inTransaction = true;

      const existing = await client.query(`
        SELECT *
        FROM ${this.tableName}
        WHERE source = $1
          AND connector_key = $2
        FOR UPDATE
      `, [
        normalized.source,
        normalized.connectorKey,
      ]);
      const row = existing.rows[0] as Record<string, unknown> | undefined;
      const now = Date.now();
      if (!row) {
        const inserted = await client.query(`
          INSERT INTO ${this.tableName} (
            source,
            connector_key,
            holder_id,
            leased_until
          ) VALUES (
            $1,
            $2,
            $3,
            $4
          )
          RETURNING *
        `, [
          normalized.source,
          normalized.connectorKey,
          normalized.holderId,
          toTimestamp(normalized.leasedUntil),
        ]);
        await client.query("COMMIT");
        return parseRecord(inserted.rows[0] as Record<string, unknown>);
      }

      const existingLease = parseRecord(row);
      if (existingLease.holderId !== normalized.holderId && existingLease.leasedUntil > now) {
        await client.query("COMMIT");
        return null;
      }

      const updated = await client.query(`
        UPDATE ${this.tableName}
        SET holder_id = $3,
            leased_until = $4,
            updated_at = NOW()
        WHERE source = $1
          AND connector_key = $2
        RETURNING *
      `, [
        normalized.source,
        normalized.connectorKey,
        normalized.holderId,
        toTimestamp(normalized.leasedUntil),
      ]);
      await client.query("COMMIT");
      return parseRecord(updated.rows[0] as Record<string, unknown>);
    } catch (error) {
      if (inTransaction) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async renew(input: ConnectorLeaseMutationInput): Promise<ConnectorLeaseRecord | null> {
    const normalized = normalizeMutation(input);
    const result = await this.pool.query(`
      UPDATE ${this.tableName}
      SET leased_until = $4,
          updated_at = NOW()
      WHERE source = $1
        AND connector_key = $2
        AND holder_id = $3
      RETURNING *
    `, [
      normalized.source,
      normalized.connectorKey,
      normalized.holderId,
      toTimestamp(normalized.leasedUntil),
    ]);
    const row = result.rows[0];
    return row ? parseRecord(row as Record<string, unknown>) : null;
  }

  async release(input: Omit<ConnectorLeaseMutationInput, "leasedUntil">): Promise<boolean> {
    const normalized = {
      ...normalizeLookup(input),
      holderId: requireConnectorLeaseString("holder id", input.holderId),
    };
    const result = await this.pool.query(`
      DELETE FROM ${this.tableName}
      WHERE source = $1
        AND connector_key = $2
        AND holder_id = $3
    `, [
      normalized.source,
      normalized.connectorKey,
      normalized.holderId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}

export async function acquireManagedConnectorLease(
  options: AcquireManagedConnectorLeaseOptions,
): Promise<ManagedConnectorLease> {
  const ttlMs = requirePositiveInteger("ttlMs", options.ttlMs ?? DEFAULT_CONNECTOR_LEASE_TTL_MS);
  const renewIntervalMs = requirePositiveInteger(
    "renewIntervalMs",
    options.renewIntervalMs ?? DEFAULT_CONNECTOR_LEASE_RENEW_INTERVAL_MS,
  );
  const source = requireConnectorLeaseString("source", options.source);
  const connectorKey = requireConnectorLeaseString("connector key", options.connectorKey);
  const holderId = options.holderId?.trim() || randomUUID();

  const acquired = await options.repo.tryAcquire({
    source,
    connectorKey,
    holderId,
    leasedUntil: Date.now() + ttlMs,
  });
  if (!acquired) {
    throw new Error(options.alreadyHeldMessage);
  }

  let released = false;
  let lost = false;
  let expiresAt = acquired.leasedUntil;
  let renewTimer: NodeJS.Timeout | null = null;

  const scheduleRenew = () => {
    if (released || lost) {
      return;
    }

    renewTimer = setTimeout(() => {
      void renewLease();
    }, renewIntervalMs);
  };

  const markLost = async (error: Error): Promise<void> => {
    if (released || lost) {
      return;
    }

    lost = true;
    if (renewTimer) {
      clearTimeout(renewTimer);
      renewTimer = null;
    }
    await options.onLeaseLost?.(error);
  };

  const renewLease = async (): Promise<void> => {
    if (released || lost) {
      return;
    }

    try {
      const renewed = await options.repo.renew({
        source,
        connectorKey,
        holderId,
        leasedUntil: Date.now() + ttlMs,
      });
      if (released || lost) {
        return;
      }
      if (!renewed) {
        await markLost(new Error(`Connector lease ${source}/${connectorKey} was lost.`));
        return;
      }

      expiresAt = renewed.leasedUntil;
    } catch (error) {
      await options.onError?.(error);
      if (released || lost) {
        return;
      }
      if (Date.now() >= expiresAt) {
        await markLost(error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }

    scheduleRenew();
  };

  scheduleRenew();

  return {
    release: async () => {
      if (released) {
        return;
      }

      released = true;
      if (renewTimer) {
        clearTimeout(renewTimer);
        renewTimer = null;
      }
      await options.repo.release({
        source,
        connectorKey,
        holderId,
      });
    },
  };
}
