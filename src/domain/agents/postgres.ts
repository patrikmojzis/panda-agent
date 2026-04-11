import type {Pool, PoolClient} from "pg";

import {quoteIdentifier, toJson, toMillis} from "../../domain/threads/runtime/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {type AgentTableNames, buildAgentTableNames} from "./postgres-shared.js";
import type {AgentStore} from "./store.js";
import type {
  AgentDiaryRecord,
  AgentDocumentRecord,
  AgentDocumentSlug,
  AgentRecord,
  BootstrapAgentInput,
  RelationshipDocumentRecord,
  RelationshipDocumentSlug,
} from "./types.js";
import {normalizeAgentKey} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

interface PgPoolLike extends PgQueryable {
  connect(): Promise<PoolClient>;
}

export interface PostgresAgentStoreOptions {
  pool: PgPoolLike;
  tablePrefix?: string;
}

function parseAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    agentKey: String(row.agent_key),
    displayName: String(row.display_name),
    status: String(row.status) as AgentRecord["status"],
    metadata: row.metadata === null ? undefined : row.metadata as AgentRecord["metadata"],
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseAgentDocumentRow(row: Record<string, unknown>): AgentDocumentRecord {
  return {
    agentKey: String(row.agent_key),
    slug: String(row.slug) as AgentDocumentSlug,
    content: String(row.content),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseRelationshipDocumentRow(row: Record<string, unknown>): RelationshipDocumentRecord {
  return {
    agentKey: String(row.agent_key),
    identityId: String(row.identity_id),
    slug: String(row.slug) as RelationshipDocumentSlug,
    content: String(row.content),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseAgentDiaryRow(row: Record<string, unknown>): AgentDiaryRecord {
  const rawEntryDate = row.entry_date;
  return {
    agentKey: String(row.agent_key),
    identityId: String(row.identity_id),
    entryDate: rawEntryDate instanceof Date
      ? rawEntryDate.toISOString().slice(0, 10)
      : String(rawEntryDate),
    content: String(row.content),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function requireIdentityId(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Identity id must not be empty.");
  }

  return trimmed;
}

function requireEntryDate(value: string): string {
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error("Diary entry date must use YYYY-MM-DD.");
  }

  return trimmed;
}

function missingAgentError(agentKey: string): Error {
  return new Error(`Unknown agent ${agentKey}. Create it with \`panda agent create ${agentKey}\`.`);
}

export class PostgresAgentStore implements AgentStore {
  private readonly pool: PgPoolLike;
  private readonly tables: AgentTableNames;
  private readonly identityTables: ReturnType<typeof buildIdentityTableNames>;

  constructor(options: PostgresAgentStoreOptions) {
    this.pool = options.pool;
    const tablePrefix = options.tablePrefix ?? "thread_runtime";
    this.tables = buildAgentTableNames(tablePrefix);
    this.identityTables = buildIdentityTableNames(tablePrefix);
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.agents} (
        agent_key TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.agentDocuments} (
        agent_key TEXT NOT NULL REFERENCES ${this.tables.agents}(agent_key) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, slug)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.relationshipDocuments} (
        agent_key TEXT NOT NULL REFERENCES ${this.tables.agents}(agent_key) ON DELETE CASCADE,
        identity_id TEXT NOT NULL REFERENCES ${this.identityTables.identities}(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, identity_id, slug)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.agentDiary} (
        agent_key TEXT NOT NULL REFERENCES ${this.tables.agents}(agent_key) ON DELETE CASCADE,
        identity_id TEXT NOT NULL REFERENCES ${this.identityTables.identities}(id) ON DELETE CASCADE,
        entry_date DATE NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, identity_id, entry_date)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_relationship_documents_lookup_idx`)}
      ON ${this.tables.relationshipDocuments} (identity_id, agent_key, slug)
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_agent_diary_lookup_idx`)}
      ON ${this.tables.agentDiary} (agent_key, identity_id, entry_date DESC)
    `);
  }

  async bootstrapAgent(input: BootstrapAgentInput): Promise<AgentRecord> {
    const agentKey = normalizeAgentKey(input.agentKey);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      const created = await client.query(`
        INSERT INTO ${this.tables.agents} (
          agent_key,
          display_name,
          status,
          metadata
        ) VALUES (
          $1,
          $2,
          $3,
          $4::jsonb
        )
        RETURNING *
      `, [
        agentKey,
        input.displayName.trim() || agentKey,
        input.status ?? "active",
        toJson(input.metadata),
      ]);

      for (const [slug, content] of Object.entries(input.documents)) {
        await client.query(`
          INSERT INTO ${this.tables.agentDocuments} (
            agent_key,
            slug,
            content
          ) VALUES (
            $1,
            $2,
            $3
          )
        `, [
          agentKey,
          slug,
          content,
        ]);
      }

      await client.query("COMMIT");
      return parseAgentRow(created.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getAgent(agentKey: string): Promise<AgentRecord> {
    const normalizedKey = normalizeAgentKey(agentKey);
    const result = await this.pool.query(
      `SELECT * FROM ${this.tables.agents} WHERE agent_key = $1`,
      [normalizedKey],
    );
    const row = result.rows[0];
    if (!row) {
      throw missingAgentError(normalizedKey);
    }

    return parseAgentRow(row as Record<string, unknown>);
  }

  async listAgents(): Promise<readonly AgentRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agents}
      ORDER BY agent_key ASC
    `);

    return result.rows.map((row) => parseAgentRow(row as Record<string, unknown>));
  }

  async readAgentDocument(agentKey: string, slug: AgentDocumentSlug): Promise<AgentDocumentRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentDocuments}
      WHERE agent_key = $1
        AND slug = $2
    `, [
      normalizeAgentKey(agentKey),
      slug,
    ]);

    const row = result.rows[0];
    return row ? parseAgentDocumentRow(row as Record<string, unknown>) : null;
  }

  async setAgentDocument(agentKey: string, slug: AgentDocumentSlug, content: string): Promise<AgentDocumentRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.agentDocuments} (
        agent_key,
        slug,
        content
      ) VALUES (
        $1,
        $2,
        $3
      )
      ON CONFLICT (agent_key, slug)
      DO UPDATE SET
        content = EXCLUDED.content,
        updated_at = NOW()
      RETURNING *
    `, [
      normalizeAgentKey(agentKey),
      slug,
      content,
    ]);

    return parseAgentDocumentRow(result.rows[0] as Record<string, unknown>);
  }

  async transformAgentDocument(agentKey: string, slug: AgentDocumentSlug, expression: string): Promise<AgentDocumentRecord> {
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    await this.pool.query(`
      INSERT INTO ${this.tables.agentDocuments} (
        agent_key,
        slug,
        content
      ) VALUES (
        $1,
        $2,
        ''
      )
      ON CONFLICT (agent_key, slug)
      DO NOTHING
    `, [
      normalizedAgentKey,
      slug,
    ]);

    const result = await this.pool.query(`
      UPDATE ${this.tables.agentDocuments}
      SET content = COALESCE((${expression})::text, ''),
          updated_at = NOW()
      WHERE agent_key = $1
        AND slug = $2
      RETURNING *
    `, [
      normalizedAgentKey,
      slug,
    ]);

    return parseAgentDocumentRow(result.rows[0] as Record<string, unknown>);
  }

  async readRelationshipDocument(
    agentKey: string,
    identityId: string,
    slug: RelationshipDocumentSlug,
  ): Promise<RelationshipDocumentRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.relationshipDocuments}
      WHERE agent_key = $1
        AND identity_id = $2
        AND slug = $3
    `, [
      normalizeAgentKey(agentKey),
      requireIdentityId(identityId),
      slug,
    ]);

    const row = result.rows[0];
    return row ? parseRelationshipDocumentRow(row as Record<string, unknown>) : null;
  }

  async setRelationshipDocument(
    agentKey: string,
    identityId: string,
    slug: RelationshipDocumentSlug,
    content: string,
  ): Promise<RelationshipDocumentRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.relationshipDocuments} (
        agent_key,
        identity_id,
        slug,
        content
      ) VALUES (
        $1,
        $2,
        $3,
        $4
      )
      ON CONFLICT (agent_key, identity_id, slug)
      DO UPDATE SET
        content = EXCLUDED.content,
        updated_at = NOW()
      RETURNING *
    `, [
      normalizeAgentKey(agentKey),
      requireIdentityId(identityId),
      slug,
      content,
    ]);

    return parseRelationshipDocumentRow(result.rows[0] as Record<string, unknown>);
  }

  async transformRelationshipDocument(
    agentKey: string,
    identityId: string,
    slug: RelationshipDocumentSlug,
    expression: string,
  ): Promise<RelationshipDocumentRecord> {
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const normalizedIdentityId = requireIdentityId(identityId);
    await this.pool.query(`
      INSERT INTO ${this.tables.relationshipDocuments} (
        agent_key,
        identity_id,
        slug,
        content
      ) VALUES (
        $1,
        $2,
        $3,
        ''
      )
      ON CONFLICT (agent_key, identity_id, slug)
      DO NOTHING
    `, [
      normalizedAgentKey,
      normalizedIdentityId,
      slug,
    ]);

    const result = await this.pool.query(`
      UPDATE ${this.tables.relationshipDocuments}
      SET content = COALESCE((${expression})::text, ''),
          updated_at = NOW()
      WHERE agent_key = $1
        AND identity_id = $2
        AND slug = $3
      RETURNING *
    `, [
      normalizedAgentKey,
      normalizedIdentityId,
      slug,
    ]);

    return parseRelationshipDocumentRow(result.rows[0] as Record<string, unknown>);
  }

  async readDiaryEntry(agentKey: string, identityId: string, entryDate: string): Promise<AgentDiaryRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentDiary}
      WHERE agent_key = $1
        AND identity_id = $2
        AND entry_date = $3::date
    `, [
      normalizeAgentKey(agentKey),
      requireIdentityId(identityId),
      requireEntryDate(entryDate),
    ]);

    const row = result.rows[0];
    return row ? parseAgentDiaryRow(row as Record<string, unknown>) : null;
  }

  async setDiaryEntry(agentKey: string, identityId: string, entryDate: string, content: string): Promise<AgentDiaryRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.agentDiary} (
        agent_key,
        identity_id,
        entry_date,
        content
      ) VALUES (
        $1,
        $2,
        $3::date,
        $4
      )
      ON CONFLICT (agent_key, identity_id, entry_date)
      DO UPDATE SET
        content = EXCLUDED.content,
        updated_at = NOW()
      RETURNING *
    `, [
      normalizeAgentKey(agentKey),
      requireIdentityId(identityId),
      requireEntryDate(entryDate),
      content,
    ]);

    return parseAgentDiaryRow(result.rows[0] as Record<string, unknown>);
  }

  async transformDiaryEntry(agentKey: string, identityId: string, entryDate: string, expression: string): Promise<AgentDiaryRecord> {
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const normalizedIdentityId = requireIdentityId(identityId);
    const normalizedEntryDate = requireEntryDate(entryDate);
    await this.pool.query(`
      INSERT INTO ${this.tables.agentDiary} (
        agent_key,
        identity_id,
        entry_date,
        content
      ) VALUES (
        $1,
        $2,
        $3::date,
        ''
      )
      ON CONFLICT (agent_key, identity_id, entry_date)
      DO NOTHING
    `, [
      normalizedAgentKey,
      normalizedIdentityId,
      normalizedEntryDate,
    ]);

    const result = await this.pool.query(`
      UPDATE ${this.tables.agentDiary}
      SET content = COALESCE((${expression})::text, ''),
          updated_at = NOW()
      WHERE agent_key = $1
        AND identity_id = $2
        AND entry_date = $3::date
      RETURNING *
    `, [
      normalizedAgentKey,
      normalizedIdentityId,
      normalizedEntryDate,
    ]);

    return parseAgentDiaryRow(result.rows[0] as Record<string, unknown>);
  }

  async listDiaryEntries(agentKey: string, identityId: string, limit = 7): Promise<readonly AgentDiaryRecord[]> {
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 7;
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentDiary}
      WHERE agent_key = $1
        AND identity_id = $2
      ORDER BY entry_date DESC
      LIMIT $3
    `, [
      normalizeAgentKey(agentKey),
      requireIdentityId(identityId),
      safeLimit,
    ]);

    return result.rows.map((row) => parseAgentDiaryRow(row as Record<string, unknown>));
  }
}
