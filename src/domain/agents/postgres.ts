import type {Pool, PoolClient} from "pg";

import {quoteIdentifier, toJson, toMillis} from "../../domain/threads/runtime/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {type AgentTableNames, buildAgentTableNames} from "./postgres-shared.js";
import type {AgentStore} from "./store.js";
import type {
    AgentDiaryRecord,
    AgentDocumentRecord,
    AgentDocumentSlug,
    AgentPairingRecord,
    AgentPromptRecord,
    AgentPromptSlug,
    AgentRecord,
    AgentSkillRecord,
    BootstrapAgentInput,
} from "./types.js";
import {
    normalizeAgentKey,
    normalizeAgentSkillContent,
    normalizeAgentSkillDescription,
    normalizeSkillKey,
} from "./types.js";

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

function parseAgentPromptRow(row: Record<string, unknown>): AgentPromptRecord {
  return {
    agentKey: String(row.agent_key),
    slug: String(row.slug) as AgentPromptSlug,
    content: String(row.content),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseAgentDocumentRow(row: Record<string, unknown>): AgentDocumentRecord {
  return {
    agentKey: String(row.agent_key),
    identityId: row.identity_id === null ? undefined : String(row.identity_id),
    slug: String(row.slug) as AgentDocumentSlug,
    content: String(row.content),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseAgentSkillRow(row: Record<string, unknown>): AgentSkillRecord {
  return {
    agentKey: String(row.agent_key),
    skillKey: String(row.skill_key),
    description: String(row.description),
    content: String(row.content),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseAgentDiaryRow(row: Record<string, unknown>): AgentDiaryRecord {
  const rawEntryDate = row.entry_date;
  return {
    agentKey: String(row.agent_key),
    identityId: row.identity_id === null ? undefined : String(row.identity_id),
    entryDate: rawEntryDate instanceof Date
      ? rawEntryDate.toISOString().slice(0, 10)
      : String(rawEntryDate),
    content: String(row.content),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function parseAgentPairingRow(row: Record<string, unknown>): AgentPairingRecord {
  return {
    agentKey: String(row.agent_key),
    identityId: String(row.identity_id),
    metadata: row.metadata === null ? undefined : row.metadata as AgentPairingRecord["metadata"],
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

function normalizeOptionalIdentityId(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return requireIdentityId(value);
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

function isUniqueViolation(error: unknown): error is { code: string } {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "23505";
}

const AGENT_PROMPT_SLUG_SET = new Set<AgentPromptSlug>(["agent", "soul", "heartbeat"]);

function isPromptSlug(slug: string): slug is AgentPromptSlug {
  return AGENT_PROMPT_SLUG_SET.has(slug as AgentPromptSlug);
}

function looksLikeEntryDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
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
      CREATE TABLE IF NOT EXISTS ${this.tables.agentPairings} (
        agent_key TEXT NOT NULL REFERENCES ${this.tables.agents}(agent_key) ON DELETE CASCADE,
        identity_id TEXT NOT NULL REFERENCES ${this.identityTables.identities}(id) ON DELETE CASCADE,
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, identity_id)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_agent_pairings_identity_idx`)}
      ON ${this.tables.agentPairings} (identity_id, agent_key)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.agentSkills} (
        agent_key TEXT NOT NULL REFERENCES ${this.tables.agents}(agent_key) ON DELETE CASCADE,
        skill_key TEXT NOT NULL,
        description TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, skill_key)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.agentPrompts} (
        agent_key TEXT NOT NULL REFERENCES ${this.tables.agents}(agent_key) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, slug)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.agentDocuments} (
        id BIGSERIAL PRIMARY KEY,
        agent_key TEXT NOT NULL REFERENCES ${this.tables.agents}(agent_key) ON DELETE CASCADE,
        identity_id TEXT REFERENCES ${this.identityTables.identities}(id) ON DELETE CASCADE,
        slug TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_agent_documents_global_idx`)}
      ON ${this.tables.agentDocuments} (agent_key, slug)
      WHERE identity_id IS NULL
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_agent_documents_scoped_idx`)}
      ON ${this.tables.agentDocuments} (agent_key, identity_id, slug)
      WHERE identity_id IS NOT NULL
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.agentDiary} (
        id BIGSERIAL PRIMARY KEY,
        agent_key TEXT NOT NULL REFERENCES ${this.tables.agents}(agent_key) ON DELETE CASCADE,
        identity_id TEXT REFERENCES ${this.identityTables.identities}(id) ON DELETE CASCADE,
        entry_date DATE NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_agent_diary_global_idx`)}
      ON ${this.tables.agentDiary} (agent_key, entry_date)
      WHERE identity_id IS NULL
    `);
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_agent_diary_scoped_idx`)}
      ON ${this.tables.agentDiary} (agent_key, identity_id, entry_date)
      WHERE identity_id IS NOT NULL
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_agent_diary_lookup_idx`)}
      ON ${this.tables.agentDiary} (agent_key, identity_id, entry_date DESC)
    `);
  }

  async bootstrapAgent(input: BootstrapAgentInput): Promise<AgentRecord> {
    const agentKey = normalizeAgentKey(input.agentKey);
    const prompts = input.prompts ?? {};
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

      for (const [slug, content] of Object.entries(prompts)) {
        await client.query(`
          INSERT INTO ${this.tables.agentPrompts} (
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

  async ensurePairing(agentKey: string, identityId: string): Promise<AgentPairingRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.agentPairings} (
        agent_key,
        identity_id
      ) VALUES (
        $1,
        $2
      )
      ON CONFLICT (agent_key, identity_id)
      DO UPDATE SET updated_at = NOW()
      RETURNING *
    `, [
      normalizeAgentKey(agentKey),
      requireIdentityId(identityId),
    ]);

    return parseAgentPairingRow(result.rows[0] as Record<string, unknown>);
  }

  async deletePairing(agentKey: string, identityId: string): Promise<boolean> {
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.agentPairings}
      WHERE agent_key = $1
        AND identity_id = $2
    `, [
      normalizeAgentKey(agentKey),
      requireIdentityId(identityId),
    ]);

    return (result.rowCount ?? 0) > 0;
  }

  async listAgentPairings(agentKey: string): Promise<readonly AgentPairingRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentPairings}
      WHERE agent_key = $1
      ORDER BY created_at ASC
    `, [normalizeAgentKey(agentKey)]);

    return result.rows.map((row) => parseAgentPairingRow(row as Record<string, unknown>));
  }

  async listIdentityPairings(identityId: string): Promise<readonly AgentPairingRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentPairings}
      WHERE identity_id = $1
      ORDER BY created_at ASC
    `, [requireIdentityId(identityId)]);

    return result.rows.map((row) => parseAgentPairingRow(row as Record<string, unknown>));
  }

  async listAgentSkills(agentKey: string): Promise<readonly AgentSkillRecord[]> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentSkills}
      WHERE agent_key = $1
      ORDER BY skill_key ASC
    `, [
      normalizeAgentKey(agentKey),
    ]);

    return result.rows.map((row) => parseAgentSkillRow(row as Record<string, unknown>));
  }

  async readAgentSkill(agentKey: string, skillKey: string): Promise<AgentSkillRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentSkills}
      WHERE agent_key = $1
        AND skill_key = $2
    `, [
      normalizeAgentKey(agentKey),
      normalizeSkillKey(skillKey),
    ]);

    const row = result.rows[0];
    return row ? parseAgentSkillRow(row as Record<string, unknown>) : null;
  }

  async setAgentSkill(agentKey: string, skillKey: string, description: string, content: string): Promise<AgentSkillRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.agentSkills} (
        agent_key,
        skill_key,
        description,
        content
      ) VALUES (
        $1,
        $2,
        $3,
        $4
      )
      ON CONFLICT (agent_key, skill_key)
      DO UPDATE SET
        description = EXCLUDED.description,
        content = EXCLUDED.content,
        updated_at = NOW()
      RETURNING *
    `, [
      normalizeAgentKey(agentKey),
      normalizeSkillKey(skillKey),
      normalizeAgentSkillDescription(description),
      normalizeAgentSkillContent(content),
    ]);

    return parseAgentSkillRow(result.rows[0] as Record<string, unknown>);
  }

  async deleteAgentSkill(agentKey: string, skillKey: string): Promise<boolean> {
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.agentSkills}
      WHERE agent_key = $1
        AND skill_key = $2
    `, [
      normalizeAgentKey(agentKey),
      normalizeSkillKey(skillKey),
    ]);

    return (result.rowCount ?? 0) > 0;
  }

  async readAgentPrompt(agentKey: string, slug: AgentPromptSlug): Promise<AgentPromptRecord | null> {
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentPrompts}
      WHERE agent_key = $1
        AND slug = $2
    `, [
      normalizeAgentKey(agentKey),
      slug,
    ]);

    const row = result.rows[0];
    return row ? parseAgentPromptRow(row as Record<string, unknown>) : null;
  }

  async setAgentPrompt(agentKey: string, slug: AgentPromptSlug, content: string): Promise<AgentPromptRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.agentPrompts} (
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

    return parseAgentPromptRow(result.rows[0] as Record<string, unknown>);
  }

  async transformAgentPrompt(agentKey: string, slug: AgentPromptSlug, expression: string): Promise<AgentPromptRecord> {
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    await this.pool.query(`
      INSERT INTO ${this.tables.agentPrompts} (
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
      UPDATE ${this.tables.agentPrompts}
      SET content = COALESCE((${expression})::text, ''),
          updated_at = NOW()
      WHERE agent_key = $1
        AND slug = $2
      RETURNING *
    `, [
      normalizedAgentKey,
      slug,
    ]);

    return parseAgentPromptRow(result.rows[0] as Record<string, unknown>);
  }

  private async readScopedDocumentRow(
    agentKey: string,
    slug: AgentDocumentSlug,
    identityId?: string,
  ): Promise<Record<string, unknown> | null> {
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const normalizedIdentityId = normalizeOptionalIdentityId(identityId);
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentDocuments}
      WHERE agent_key = $1
        AND slug = $2
        AND ${normalizedIdentityId ? "identity_id = $3" : "identity_id IS NULL"}
      LIMIT 1
    `, normalizedIdentityId
      ? [normalizedAgentKey, slug, normalizedIdentityId]
      : [normalizedAgentKey, slug],
    );
    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  async readAgentDocument(agentKey: string, slug: AgentDocumentSlug, identityId?: string): Promise<AgentDocumentRecord | null> {
    if (identityId === undefined && isPromptSlug(slug)) {
      const prompt = await this.readAgentPrompt(agentKey, slug);
      return prompt
        ? {
          agentKey: prompt.agentKey,
          slug: prompt.slug as AgentDocumentSlug,
          content: prompt.content,
          createdAt: prompt.createdAt,
          updatedAt: prompt.updatedAt,
        }
        : null;
    }

    const row = await this.readScopedDocumentRow(agentKey, slug, identityId);
    return row ? parseAgentDocumentRow(row) : null;
  }

  async setAgentDocument(agentKey: string, slug: AgentDocumentSlug, content: string, identityId?: string): Promise<AgentDocumentRecord> {
    if (identityId === undefined && isPromptSlug(slug)) {
      const prompt = await this.setAgentPrompt(agentKey, slug, content);
      return {
        agentKey: prompt.agentKey,
        slug: prompt.slug as AgentDocumentSlug,
        content: prompt.content,
        createdAt: prompt.createdAt,
        updatedAt: prompt.updatedAt,
      };
    }

    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const normalizedIdentityId = normalizeOptionalIdentityId(identityId);
    const existing = await this.readScopedDocumentRow(normalizedAgentKey, slug, normalizedIdentityId);
    if (existing) {
      const result = await this.pool.query(`
        UPDATE ${this.tables.agentDocuments}
        SET content = $2,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [
        Number(existing.id),
        content,
      ]);
      return parseAgentDocumentRow(result.rows[0] as Record<string, unknown>);
    }

    try {
      const result = await this.pool.query(`
        INSERT INTO ${this.tables.agentDocuments} (
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
        RETURNING *
      `, [
        normalizedAgentKey,
        normalizedIdentityId ?? null,
        slug,
        content,
      ]);
      return parseAgentDocumentRow(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      return this.setAgentDocument(normalizedAgentKey, slug, content, normalizedIdentityId);
    }
  }

  async transformAgentDocument(agentKey: string, slug: AgentDocumentSlug, expression: string, identityId?: string): Promise<AgentDocumentRecord> {
    if (identityId === undefined && isPromptSlug(slug)) {
      const prompt = await this.transformAgentPrompt(agentKey, slug, expression);
      return {
        agentKey: prompt.agentKey,
        slug: prompt.slug as AgentDocumentSlug,
        content: prompt.content,
        createdAt: prompt.createdAt,
        updatedAt: prompt.updatedAt,
      };
    }

    let existing = await this.readScopedDocumentRow(agentKey, slug, identityId);
    if (!existing) {
      await this.setAgentDocument(agentKey, slug, "", identityId);
      existing = await this.readScopedDocumentRow(agentKey, slug, identityId);
    }
    const result = await this.pool.query(`
      UPDATE ${this.tables.agentDocuments}
      SET content = COALESCE((${expression})::text, ''),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [Number(existing?.id)]);

    return parseAgentDocumentRow(result.rows[0] as Record<string, unknown>);
  }

  async readRelationshipDocument(agentKey: string, identityId: string, slug: AgentDocumentSlug): Promise<AgentDocumentRecord | null> {
    return this.readAgentDocument(agentKey, slug, identityId);
  }

  async setRelationshipDocument(
    agentKey: string,
    identityId: string,
    slug: AgentDocumentSlug,
    content: string,
  ): Promise<AgentDocumentRecord> {
    return this.setAgentDocument(agentKey, slug, content, identityId);
  }

  async transformRelationshipDocument(
    agentKey: string,
    identityId: string,
    slug: AgentDocumentSlug,
    expression: string,
  ): Promise<AgentDocumentRecord> {
    return this.transformAgentDocument(agentKey, slug, expression, identityId);
  }

  private async readDiaryRow(agentKey: string, entryDate: string, identityId?: string): Promise<Record<string, unknown> | null> {
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const normalizedEntryDate = requireEntryDate(entryDate);
    const normalizedIdentityId = normalizeOptionalIdentityId(identityId);
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentDiary}
      WHERE agent_key = $1
        AND entry_date = $2::date
        AND ${normalizedIdentityId ? "identity_id = $3" : "identity_id IS NULL"}
      LIMIT 1
    `, normalizedIdentityId
      ? [normalizedAgentKey, normalizedEntryDate, normalizedIdentityId]
      : [normalizedAgentKey, normalizedEntryDate],
    );

    return (result.rows[0] as Record<string, unknown> | undefined) ?? null;
  }

  private normalizeDiaryReadArgs(arg2: string, arg3?: string): {entryDate: string; identityId?: string} {
    return looksLikeEntryDate(arg2)
      ? {entryDate: arg2, identityId: arg3}
      : {entryDate: arg3 ?? "", identityId: arg2};
  }

  private normalizeDiaryWriteArgs(
    arg2: string,
    arg3: string,
    arg4?: string,
  ): {entryDate: string; content: string; identityId?: string} {
    return looksLikeEntryDate(arg2)
      ? {entryDate: arg2, content: arg3, identityId: arg4}
      : {entryDate: arg3, content: arg4 ?? "", identityId: arg2};
  }

  private normalizeDiaryListArgs(
    arg2?: number | string,
    arg3?: string | number,
  ): {limit: number; identityId?: string} {
    if (typeof arg2 === "number" || arg2 === undefined) {
      return {
        limit: arg2 ?? 7,
        identityId: typeof arg3 === "string" ? arg3 : undefined,
      };
    }

    return {
      identityId: arg2,
      limit: typeof arg3 === "number" ? arg3 : 7,
    };
  }

  async readDiaryEntry(agentKey: string, entryDate: string, identityId?: string): Promise<AgentDiaryRecord | null>;
  async readDiaryEntry(agentKey: string, identityId: string, entryDate: string): Promise<AgentDiaryRecord | null>;
  async readDiaryEntry(agentKey: string, arg2: string, arg3?: string): Promise<AgentDiaryRecord | null> {
    const {entryDate, identityId} = this.normalizeDiaryReadArgs(arg2, arg3);
    const row = await this.readDiaryRow(agentKey, entryDate, identityId);
    return row ? parseAgentDiaryRow(row) : null;
  }

  async setDiaryEntry(agentKey: string, entryDate: string, content: string, identityId?: string): Promise<AgentDiaryRecord>;
  async setDiaryEntry(agentKey: string, identityId: string, entryDate: string, content: string): Promise<AgentDiaryRecord>;
  async setDiaryEntry(agentKey: string, arg2: string, arg3: string, arg4?: string): Promise<AgentDiaryRecord> {
    const {entryDate, content, identityId} = this.normalizeDiaryWriteArgs(arg2, arg3, arg4);
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const normalizedEntryDate = requireEntryDate(entryDate);
    const normalizedIdentityId = normalizeOptionalIdentityId(identityId);
    const existing = await this.readDiaryRow(normalizedAgentKey, normalizedEntryDate, normalizedIdentityId);
    if (existing) {
      const result = await this.pool.query(`
        UPDATE ${this.tables.agentDiary}
        SET content = $2,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [
        Number(existing.id),
        content,
      ]);
      return parseAgentDiaryRow(result.rows[0] as Record<string, unknown>);
    }

    try {
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
        RETURNING *
      `, [
        normalizedAgentKey,
        normalizedIdentityId ?? null,
        normalizedEntryDate,
        content,
      ]);
      return parseAgentDiaryRow(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      return this.setDiaryEntry(normalizedAgentKey, normalizedEntryDate, content, normalizedIdentityId);
    }
  }

  async transformDiaryEntry(agentKey: string, entryDate: string, expression: string, identityId?: string): Promise<AgentDiaryRecord>;
  async transformDiaryEntry(agentKey: string, identityId: string, entryDate: string, expression: string): Promise<AgentDiaryRecord>;
  async transformDiaryEntry(agentKey: string, arg2: string, arg3: string, arg4?: string): Promise<AgentDiaryRecord> {
    const {entryDate, content: expression, identityId} = this.normalizeDiaryWriteArgs(arg2, arg3, arg4);
    let row = await this.readDiaryRow(agentKey, entryDate, identityId);
    if (!row) {
      await this.setDiaryEntry(agentKey, entryDate, "", identityId);
      row = await this.readDiaryRow(agentKey, entryDate, identityId);
    }
    const result = await this.pool.query(`
      UPDATE ${this.tables.agentDiary}
      SET content = COALESCE((${expression})::text, ''),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [Number(row?.id)]);

    return parseAgentDiaryRow(result.rows[0] as Record<string, unknown>);
  }

  async listDiaryEntries(agentKey: string, limit?: number, identityId?: string): Promise<readonly AgentDiaryRecord[]>;
  async listDiaryEntries(agentKey: string, identityId: string, limit?: number): Promise<readonly AgentDiaryRecord[]>;
  async listDiaryEntries(
    agentKey: string,
    arg2?: number | string,
    arg3?: string | number,
  ): Promise<readonly AgentDiaryRecord[]> {
    const {limit, identityId} = this.normalizeDiaryListArgs(arg2, arg3);
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 7;
    const normalizedIdentityId = normalizeOptionalIdentityId(identityId);
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.agentDiary}
      WHERE agent_key = $1
        AND ${normalizedIdentityId ? "identity_id = $2" : "identity_id IS NULL"}
      ORDER BY entry_date DESC
      LIMIT $${normalizedIdentityId ? 3 : 2}
    `, normalizedIdentityId
      ? [normalizeAgentKey(agentKey), normalizedIdentityId, safeLimit]
      : [normalizeAgentKey(agentKey), safeLimit],
    );

    return result.rows.map((row) => parseAgentDiaryRow(row as Record<string, unknown>));
  }
}
