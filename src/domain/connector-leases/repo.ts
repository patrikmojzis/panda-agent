import {randomUUID} from "node:crypto";

import type {PgPoolLike} from "../../lib/postgres-query.js";
import {POSTGRES_CONNECTOR_LEASE_TABLE} from "./postgres-schema.js";
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
  ttlMs: number;
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
    ttlMs: requirePositiveInteger("ttlMs", input.ttlMs),
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

export class PostgresConnectorLeaseRepo {
  private readonly pool: PgPoolLike;
  private readonly tableName = POSTGRES_CONNECTOR_LEASE_TABLE;

  constructor(options: PostgresConnectorLeaseRepoOptions) {
    this.pool = options.pool;
  }

  async tryAcquire(input: ConnectorLeaseMutationInput): Promise<ConnectorLeaseRecord | null> {
    const normalized = normalizeMutation(input);
    // PostgreSQL is the lease clock. An absolute timestamp supplied by a host
    // would let a fast machine steal a valid lease from a slower one.
    const result = await this.pool.query(`
      INSERT INTO ${this.tableName} (
        source,
        connector_key,
        holder_id,
        leased_until
      ) VALUES (
        $1,
        $2,
        $3,
        NOW() + (($4::text || ' milliseconds')::interval)
      )
      ON CONFLICT (source, connector_key) DO UPDATE
      SET holder_id = EXCLUDED.holder_id,
          leased_until = NOW() + (($4::text || ' milliseconds')::interval),
          updated_at = NOW()
      WHERE ${this.tableName}.holder_id = EXCLUDED.holder_id
         OR ${this.tableName}.leased_until <= NOW()
      RETURNING *
    `, [
      normalized.source,
      normalized.connectorKey,
      normalized.holderId,
      normalized.ttlMs,
    ]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    const lease = parseRecord(row as Record<string, unknown>);
    // PostgreSQL returns no row when the conflict predicate rejects takeover.
    // Keeping this holder check also makes the repository fail closed for
    // compatible test adapters that return the untouched conflicting row.
    return lease.holderId === normalized.holderId ? lease : null;
  }

  async renew(input: ConnectorLeaseMutationInput): Promise<ConnectorLeaseRecord | null> {
    const normalized = normalizeMutation(input);
    const result = await this.pool.query(`
      UPDATE ${this.tableName}
      SET leased_until = NOW() + (($4::text || ' milliseconds')::interval),
          updated_at = NOW()
      WHERE source = $1
        AND connector_key = $2
        AND holder_id = $3
        AND leased_until > NOW()
      RETURNING *
    `, [
      normalized.source,
      normalized.connectorKey,
      normalized.holderId,
      normalized.ttlMs,
    ]);
    const row = result.rows[0];
    return row ? parseRecord(row as Record<string, unknown>) : null;
  }

  async release(input: ConnectorLeaseLookup & {holderId: string}): Promise<boolean> {
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

  const acquireStartedAt = performance.now();
  const acquired = await options.repo.tryAcquire({
    source,
    connectorKey,
    holderId,
    ttlMs,
  });
  if (!acquired) {
    throw new Error(options.alreadyHeldMessage);
  }

  let released = false;
  let lost = false;
  // This monotonic deadline starts before the DB mutation, making it a safe
  // lower bound for the DB-side expiry even when clocks differ or the response
  // is delayed in transit.
  let renewalDeadline = acquireStartedAt + ttlMs;
  let renewTimer: NodeJS.Timeout | null = null;

  const scheduleRenew = () => {
    if (released || lost) {
      return;
    }

    const delayMs = Math.min(
      renewIntervalMs,
      Math.max(0, renewalDeadline - performance.now()),
    );
    renewTimer = setTimeout(() => {
      void renewLease();
    }, delayMs);
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
      const renewalStartedAt = performance.now();
      const renewed = await options.repo.renew({
        source,
        connectorKey,
        holderId,
        ttlMs,
      });
      if (released || lost) {
        return;
      }
      if (!renewed) {
        await markLost(new Error(`Connector lease ${source}/${connectorKey} was lost.`));
        return;
      }

      renewalDeadline = renewalStartedAt + ttlMs;
    } catch (error) {
      await options.onError?.(error);
      if (released || lost) {
        return;
      }
      if (performance.now() >= renewalDeadline) {
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
