import type {Pool, PoolClient} from "pg";

import type {RememberedRoute} from "../../../domain/channels/types.js";
import {CREATE_RUNTIME_SCHEMA_SQL, quoteIdentifier, toJson, toMillis} from "../../threads/runtime/postgres-shared.js";
import {buildIdentityTableNames} from "../../identity/postgres-shared.js";
import {buildSessionTableNames} from "../postgres-shared.js";
import {addConstraint, assertIntegrityChecks} from "../../../lib/postgres-integrity.js";
import {buildSessionRouteTableNames, type SessionRouteTableNames} from "./postgres-shared.js";
import type {SessionRouteInput, SessionRouteLookup, SessionRouteRecord} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface SessionRouteRepoOptions {
  pool: PgPoolLike;
}

function requireTrimmed(field: string, value: string | undefined | null): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Session route ${field} must not be empty.`);
  }

  return trimmed;
}

function normalizeLookup(lookup: SessionRouteLookup): SessionRouteLookup {
  return {
    sessionId: requireTrimmed("session id", lookup.sessionId),
    identityId: lookup.identityId?.trim() || undefined,
    channel: lookup.channel?.trim() || undefined,
  };
}

function normalizeRoute(route: RememberedRoute): RememberedRoute {
  return {
    source: requireTrimmed("source", route.source),
    connectorKey: requireTrimmed("connector key", route.connectorKey),
    externalConversationId: requireTrimmed("conversation id", route.externalConversationId),
    externalActorId: route.externalActorId?.trim() || undefined,
    externalMessageId: route.externalMessageId?.trim() || undefined,
    capturedAt: route.capturedAt,
  };
}

function normalizeInput(input: SessionRouteInput): SessionRouteInput {
  return {
    sessionId: requireTrimmed("session id", input.sessionId),
    identityId: input.identityId?.trim() || undefined,
    route: normalizeRoute(input.route),
  };
}

function parseRoute(row: Record<string, unknown>): RememberedRoute {
  return {
    source: String(row.channel),
    connectorKey: String(row.connector_key),
    externalConversationId: String(row.external_conversation_id),
    externalActorId: typeof row.external_actor_id === "string" ? row.external_actor_id : undefined,
    externalMessageId: typeof row.external_message_id === "string" ? row.external_message_id : undefined,
    capturedAt: Number(row.captured_at_ms),
  };
}

function parseRecord(row: Record<string, unknown>): SessionRouteRecord {
  const route = parseRoute(row);
  return {
    sessionId: String(row.session_id),
    identityId: typeof row.identity_id === "string" && row.identity_id.trim() ? row.identity_id : undefined,
    channel: route.source,
    route,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function isUniqueViolation(error: unknown): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && (error as {code?: unknown}).code === "23505";
}

export class SessionRouteRepo {
  private readonly pool: PgPoolLike;
  private readonly tables: SessionRouteTableNames;
  private readonly identityTableName: string;
  private readonly sessionTableName: string;

  constructor(options: SessionRouteRepoOptions) {
    this.pool = options.pool;
    this.tables = buildSessionRouteTableNames();
    this.identityTableName = buildIdentityTableNames().identities;
    this.sessionTableName = buildSessionTableNames().sessions;
  }

  private async readColumnNames(): Promise<Set<string>> {
    const result = await this.pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'runtime'
        AND table_name = 'session_routes'
    `);
    return new Set(result.rows.map((row) => String((row as {column_name?: unknown}).column_name ?? "")));
  }

  private async createSessionRoutesTable(tableName = this.tables.sessionRoutes): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${tableName} (
        id BIGSERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        identity_id TEXT,
        channel TEXT NOT NULL,
        connector_key TEXT NOT NULL,
        external_conversation_id TEXT NOT NULL,
        external_actor_id TEXT,
        external_message_id TEXT,
        captured_at_ms BIGINT NOT NULL,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }

  private async rebuildLegacyTable(): Promise<void> {
    const replacementTable = `"runtime"."session_routes_rebuild"`;
    await this.pool.query(`DROP TABLE IF EXISTS ${replacementTable}`);
    await this.createSessionRoutesTable(replacementTable);
    await this.pool.query(`
      INSERT INTO ${replacementTable} (
        session_id,
        identity_id,
        channel,
        connector_key,
        external_conversation_id,
        external_actor_id,
        external_message_id,
        captured_at_ms,
        metadata,
        created_at,
        updated_at
      )
      SELECT
        session_id,
        NULLIF(BTRIM(identity_id), ''),
        channel,
        connector_key,
        external_conversation_id,
        external_actor_id,
        external_message_id,
        captured_at_ms,
        metadata,
        created_at,
        updated_at
      FROM ${this.tables.sessionRoutes}
    `);
    await this.pool.query(`DROP TABLE ${this.tables.sessionRoutes}`);
    await this.pool.query(`ALTER TABLE ${replacementTable} RENAME TO session_routes`);
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    const existingColumns = await this.readColumnNames();
    if (existingColumns.size === 0) {
      await this.createSessionRoutesTable();
    } else if (!existingColumns.has("id")) {
      await assertIntegrityChecks(this.pool, "Session route schema", [
        {
          label: "session_routes.session_id orphaned from agent_sessions.id",
          sql: `
            SELECT COUNT(*)::INTEGER AS count
            FROM ${this.tables.sessionRoutes} AS route
            LEFT JOIN ${this.sessionTableName} AS session
              ON session.id = route.session_id
            WHERE session.id IS NULL
          `,
        },
        {
          label: "session_routes.identity_id orphaned from identities.id",
          sql: `
            SELECT COUNT(*)::INTEGER AS count
            FROM ${this.tables.sessionRoutes} AS route
            LEFT JOIN ${this.identityTableName} AS identity
              ON identity.id = NULLIF(BTRIM(route.identity_id), '')
            WHERE NULLIF(BTRIM(route.identity_id), '') IS NOT NULL
              AND identity.id IS NULL
          `,
        },
      ]);
      await this.rebuildLegacyTable();
    } else {
      await this.createSessionRoutesTable();
    }
    await this.pool.query(`
      ALTER TABLE ${this.tables.sessionRoutes}
      ALTER COLUMN identity_id DROP NOT NULL
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.sessionRoutes}
      ALTER COLUMN identity_id DROP DEFAULT
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_session_routes_lookup_idx`)}
      ON ${this.tables.sessionRoutes} (session_id, identity_id, captured_at_ms DESC)
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_session_routes_global_unique_idx`)}
      ON ${this.tables.sessionRoutes} (session_id, channel)
      WHERE identity_id IS NULL
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_session_routes_identity_unique_idx`)}
      ON ${this.tables.sessionRoutes} (session_id, identity_id, channel)
      WHERE identity_id IS NOT NULL
    `);
    await assertIntegrityChecks(this.pool, "Session route schema", [
      {
        label: "session_routes.session_id orphaned from agent_sessions.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.sessionRoutes} AS route
          LEFT JOIN ${this.sessionTableName} AS session
            ON session.id = route.session_id
          WHERE session.id IS NULL
        `,
      },
      {
        label: "session_routes.identity_id orphaned from identities.id",
        sql: `
          SELECT COUNT(*)::INTEGER AS count
          FROM ${this.tables.sessionRoutes} AS route
          LEFT JOIN ${this.identityTableName} AS identity
            ON identity.id = route.identity_id
          WHERE route.identity_id IS NOT NULL
            AND identity.id IS NULL
        `,
      },
    ]);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.sessionRoutes}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_session_routes_session_fk`)}
      FOREIGN KEY (session_id)
      REFERENCES ${this.sessionTableName}(id)
      ON DELETE CASCADE
    `);
    await addConstraint(this.pool, `
      ALTER TABLE ${this.tables.sessionRoutes}
      ADD CONSTRAINT ${quoteIdentifier(`${this.tables.prefix}_session_routes_identity_fk`)}
      FOREIGN KEY (identity_id)
      REFERENCES ${this.identityTableName}(id)
      ON DELETE CASCADE
    `);
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
