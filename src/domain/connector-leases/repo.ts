import {randomUUID} from "node:crypto";

import type {Pool, PoolClient} from "pg";

import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier, toMillis} from "../threads/runtime/postgres-shared.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

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
  holderId: string;
  isHeld(): boolean;
  release(): Promise<void>;
}

export interface AcquireManagedConnectorLeaseOptions {
  repo: PostgresConnectorLeaseRepo;
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

function requireTrimmed(field: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Connector lease ${field} must not be empty.`);
  }

  return trimmed;
}

function requirePositiveInteger(field: string, value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Connector lease ${field} must be a positive integer.`);
  }

  return value;
}

function normalizeLookup(input: ConnectorLeaseLookup): ConnectorLeaseLookup {
  return {
    source: requireTrimmed("source", input.source),
    connectorKey: requireTrimmed("connector key", input.connectorKey),
  };
}

function normalizeMutation(input: ConnectorLeaseMutationInput): ConnectorLeaseMutationInput {
  const lookup = normalizeLookup(input);
  return {
    ...lookup,
    holderId: requireTrimmed("holder id", input.holderId),
    leasedUntil: requirePositiveInteger("leasedUntil", input.leasedUntil),
  };
}

function parseRecord(row: Record<string, unknown>): ConnectorLeaseRecord {
  return {
    source: String(row.source),
    connectorKey: String(row.connector_key),
    holderId: String(row.holder_id),
    leasedUntil: toMillis(row.leased_until),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function toTimestamp(value: number): Date {
  return new Date(value);
}

export class PostgresConnectorLeaseRepo {
  private readonly pool: PgPoolLike;
  private readonly tableName = `"runtime"."connector_leases"`;

  constructor(options: PostgresConnectorLeaseRepoOptions) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        source TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        holder_id TEXT NOT NULL,
        leased_until TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (source, connector_key)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier("runtime_connector_leases_expiry_idx")}
      ON ${this.tableName} (leased_until)
    `);
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
      holderId: requireTrimmed("holder id", input.holderId),
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
  const source = requireTrimmed("source", options.source);
  const connectorKey = requireTrimmed("connector key", options.connectorKey);
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
    holderId,
    isHeld: () => !released && !lost,
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
