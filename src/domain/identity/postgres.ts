import {randomUUID} from "node:crypto";

import {readOptionalJsonValue, stringifyOptionalJsonValue} from "../../lib/json.js";
import {isUniqueViolation} from "../../lib/postgres-errors.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {requireTimestampMillis} from "../../lib/postgres-values.js";
import {buildIdentityTableNames, type IdentityTableNames} from "./postgres-shared.js";
import {ensurePostgresIdentitySchema} from "./postgres-schema.js";
import {
    type CreateIdentityBindingInput,
    type CreateIdentityInput,
    type EnsureIdentityBindingInput,
    type IdentityBindingLookup,
    type IdentityBindingRecord,
    type IdentityRecord,
    normalizeIdentityHandle,
    type UpdateIdentityInput,
} from "./types.js";
import type {IdentityStore} from "./store.js";

export interface PostgresIdentityStoreOptions {
  pool: PgQueryable;
}

function parseString(value: unknown, errorMessage: string): string {
  if (typeof value !== "string") {
    throw new Error(errorMessage);
  }

  return value;
}

function parseIdentityStatus(value: unknown): IdentityRecord["status"] {
  if (value === "active" || value === "deleted") {
    return value;
  }

  throw new Error(`Unsupported identity status ${String(value)}.`);
}

function requireTrimmedBindingKeyPart(field: string, value: string): string {
  return requireNonEmptyString(value, `Identity binding ${field} must not be empty.`);
}

function requireOpaqueExternalActorId(value: string): string {
  if (value.trim().length === 0) {
    throw new Error("Identity binding external actor id must not be empty.");
  }

  return value;
}

function normalizeIdentityBindingLookup(lookup: IdentityBindingLookup): IdentityBindingLookup {
  return {
    source: requireTrimmedBindingKeyPart("source", lookup.source),
    connectorKey: requireTrimmedBindingKeyPart("connector key", lookup.connectorKey),
    externalActorId: requireOpaqueExternalActorId(lookup.externalActorId),
  };
}

function normalizeIdentityBindingInput<T extends IdentityBindingLookup>(input: T): T {
  const lookup = normalizeIdentityBindingLookup(input);
  return {
    ...input,
    ...lookup,
  } as T;
}

function parseIdentityRow(row: Record<string, unknown>): IdentityRecord {
  return {
    id: requireNonEmptyString(row.id, "Identity row is missing id."),
    handle: normalizeIdentityHandle(
      requireNonEmptyString(row.handle, "Identity row is missing handle."),
    ),
    displayName: parseString(row.display_name, "Identity row is missing display name."),
    status: parseIdentityStatus(row.status),
    metadata: readOptionalJsonValue(row.metadata, "Identity metadata"),
    createdAt: requireTimestampMillis(row.created_at, "Identity created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Identity updated_at must be a valid timestamp."),
  };
}

function parseIdentityBindingRow(row: Record<string, unknown>): IdentityBindingRecord {
  const lookup = normalizeIdentityBindingLookup({
    source: requireNonEmptyString(row.source, "Identity binding row is missing source."),
    connectorKey: requireNonEmptyString(row.connector_key, "Identity binding row is missing connector key."),
    externalActorId: parseString(
      row.external_actor_id,
      "Identity binding row is missing external actor id.",
    ),
  });

  return {
    id: requireNonEmptyString(row.id, "Identity binding row is missing id."),
    identityId: requireNonEmptyString(row.identity_id, "Identity binding row is missing identity id."),
    source: lookup.source,
    connectorKey: lookup.connectorKey,
    externalActorId: lookup.externalActorId,
    metadata: readOptionalJsonValue(row.metadata, "Identity binding metadata"),
    createdAt: requireTimestampMillis(row.created_at, "Identity binding created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Identity binding updated_at must be a valid timestamp."),
  };
}

function missingIdentityError(identityId: string): Error {
  return new Error(`Unknown identity ${identityId}`);
}

function missingIdentityHandleError(handle: string): Error {
  return new Error(`Unknown identity handle ${handle}`);
}

function describeBindingKey(lookup: IdentityBindingLookup): string {
  return `${lookup.source}/${lookup.connectorKey}/${lookup.externalActorId}`;
}

function bindingBelongsToDifferentIdentityError(
  lookup: IdentityBindingLookup,
  expectedIdentityId: string,
  actualIdentityId: string,
): Error {
  return new Error(
    `Identity binding ${describeBindingKey(lookup)} already belongs to identity ${actualIdentityId}, not ${expectedIdentityId}.`,
  );
}

export class PostgresIdentityStore implements IdentityStore {
  private readonly pool: PgQueryable;
  private readonly tables: IdentityTableNames;

  constructor(options: PostgresIdentityStoreOptions) {
    this.pool = options.pool;
    this.tables = buildIdentityTableNames();
  }

  private async insertIdentityBinding(input: CreateIdentityBindingInput): Promise<IdentityBindingRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.identityBindings} (
        id,
        identity_id,
        source,
        connector_key,
        external_actor_id,
        metadata
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb
      )
      RETURNING *
    `, [
      input.id,
      input.identityId,
      input.source,
      input.connectorKey,
      input.externalActorId,
      stringifyOptionalJsonValue(input.metadata, "Identity binding metadata"),
    ]);

    return parseIdentityBindingRow(result.rows[0] as Record<string, unknown>);
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresIdentitySchema(this.pool);
  }

  async createIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.identities} (
        id,
        handle,
        display_name,
        status,
        metadata
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::jsonb
      )
      RETURNING *
    `, [
      input.id,
      normalizeIdentityHandle(input.handle),
      input.displayName,
      parseIdentityStatus(input.status ?? "active"),
      stringifyOptionalJsonValue(input.metadata, "Identity metadata"),
    ]);

    return parseIdentityRow(result.rows[0] as Record<string, unknown>);
  }

  async ensureIdentity(input: CreateIdentityInput): Promise<IdentityRecord> {
    const existingResult = await this.pool.query(
      `SELECT * FROM ${this.tables.identities} WHERE id = $1`,
      [input.id],
    );

    const existing = existingResult.rows[0];
    if (existing) {
      return parseIdentityRow(existing as Record<string, unknown>);
    }

    return this.createIdentity(input);
  }

  async updateIdentity(input: UpdateIdentityInput): Promise<IdentityRecord> {
    const assignments: string[] = [];
    const values: unknown[] = [input.identityId];
    let index = 2;

    if (input.displayName !== undefined) {
      assignments.push(`display_name = $${index}`);
      values.push(input.displayName.trim());
      index += 1;
    }

    if (input.status !== undefined) {
      assignments.push(`status = $${index}`);
      values.push(parseIdentityStatus(input.status));
      index += 1;
    }

    if (input.metadata !== undefined) {
      assignments.push(`metadata = $${index}::jsonb`);
      values.push(stringifyOptionalJsonValue(input.metadata, "Identity metadata"));
      index += 1;
    }

    if (assignments.length === 0) {
      return this.getIdentity(input.identityId);
    }

    const result = await this.pool.query(`
      UPDATE ${this.tables.identities}
      SET ${assignments.join(", ")},
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, values);
    const row = result.rows[0];
    if (!row) {
      throw missingIdentityError(input.identityId);
    }

    return parseIdentityRow(row as Record<string, unknown>);
  }

  async getIdentity(identityId: string): Promise<IdentityRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.identities} WHERE id = $1`,
      [identityId],
    );

    const row = result.rows[0];
    if (!row) {
      throw missingIdentityError(identityId);
    }

    return parseIdentityRow(row as Record<string, unknown>);
  }

  async getIdentityByHandle(handle: string): Promise<IdentityRecord> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.identities} WHERE handle = $1`,
      [normalizeIdentityHandle(handle)],
    );

    const row = result.rows[0];
    if (!row) {
      throw missingIdentityHandleError(handle);
    }

    return parseIdentityRow(row as Record<string, unknown>);
  }

  async listIdentities(): Promise<readonly IdentityRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.identities} ORDER BY created_at ASC`,
    );

    return result.rows.map((row) => parseIdentityRow(row as Record<string, unknown>));
  }

  async createIdentityBinding(input: CreateIdentityBindingInput): Promise<IdentityBindingRecord> {
    const normalizedInput = normalizeIdentityBindingInput(input);
    await this.getIdentity(normalizedInput.identityId);
    return this.insertIdentityBinding(normalizedInput);
  }

  async ensureIdentityBinding(input: EnsureIdentityBindingInput): Promise<IdentityBindingRecord> {
    const normalizedInput = normalizeIdentityBindingInput(input);
    await this.getIdentity(normalizedInput.identityId);

    const lookup = {
      source: normalizedInput.source,
      connectorKey: normalizedInput.connectorKey,
      externalActorId: normalizedInput.externalActorId,
    } satisfies IdentityBindingLookup;
    const existing = await this.resolveIdentityBinding(lookup);
    if (existing) {
      if (existing.identityId !== normalizedInput.identityId) {
        throw bindingBelongsToDifferentIdentityError(lookup, normalizedInput.identityId, existing.identityId);
      }

      return existing;
    }

    try {
      return await this.insertIdentityBinding({
        ...normalizedInput,
        id: normalizedInput.id ?? randomUUID(),
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      const raced = await this.resolveIdentityBinding(lookup);
      if (!raced) {
        throw error;
      }

      if (raced.identityId !== normalizedInput.identityId) {
        throw bindingBelongsToDifferentIdentityError(lookup, normalizedInput.identityId, raced.identityId);
      }

      return raced;
    }
  }

  async resolveIdentityBinding(lookup: IdentityBindingLookup): Promise<IdentityBindingRecord | null> {
    const normalizedLookup = normalizeIdentityBindingLookup(lookup);
    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.identityBindings}
        WHERE source = $1
          AND connector_key = $2
          AND external_actor_id = $3
      `,
      [normalizedLookup.source, normalizedLookup.connectorKey, normalizedLookup.externalActorId],
    );

    const row = result.rows[0];
    return row ? parseIdentityBindingRow(row as Record<string, unknown>) : null;
  }

  async listIdentityBindings(identityId: string): Promise<readonly IdentityBindingRecord[]> {
    await this.getIdentity(identityId);

    const result = await this.pool.query(
      `
        SELECT *
        FROM ${this.tables.identityBindings}
        WHERE identity_id = $1
        ORDER BY created_at ASC
      `,
      [identityId],
    );

    return result.rows.map((row) => parseIdentityBindingRow(row as Record<string, unknown>));
  }

  async deleteIdentityBinding(lookup: IdentityBindingLookup): Promise<boolean> {
    const normalizedLookup = normalizeIdentityBindingLookup(lookup);
    const result = await this.pool.query(
      `
        DELETE FROM ${this.tables.identityBindings}
        WHERE source = $1
          AND connector_key = $2
          AND external_actor_id = $3
      `,
      [normalizedLookup.source, normalizedLookup.connectorKey, normalizedLookup.externalActorId],
    );

    return (result.rowCount ?? 0) > 0;
  }
}
