import type {Pool, PoolClient} from "pg";

import {
  CREATE_RUNTIME_SCHEMA_SQL,
  quoteIdentifier,
  toJson,
  toMillis
} from "../../domain/threads/runtime/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {type AgentTableNames, buildAgentTableNames} from "./postgres-shared.js";
import type {AgentStore} from "./store.js";
import type {
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

function parseAgentSkillRow(row: Record<string, unknown>): AgentSkillRecord {
  return {
    agentKey: String(row.agent_key),
    skillKey: String(row.skill_key),
    description: String(row.description),
    content: String(row.content),
    lastLoadedAt: row.last_loaded_at === null || row.last_loaded_at === undefined
      ? undefined
      : toMillis(row.last_loaded_at),
    loadCount: Number(row.load_count ?? 0),
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

function missingAgentError(agentKey: string): Error {
  return new Error(`Unknown agent ${agentKey}. Create it with \`panda agent create ${agentKey}\`.`);
}

export class PostgresAgentStore implements AgentStore {
  private readonly pool: PgPoolLike;
  private readonly tables: AgentTableNames;
  private readonly identityTables: ReturnType<typeof buildIdentityTableNames>;

  constructor(options: PostgresAgentStoreOptions) {
    this.pool = options.pool;
    this.tables = buildAgentTableNames();
    this.identityTables = buildIdentityTableNames();
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
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
        last_loaded_at TIMESTAMPTZ,
        load_count INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, skill_key)
      )
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.agentSkills}
      ADD COLUMN IF NOT EXISTS last_loaded_at TIMESTAMPTZ
    `);
    await this.pool.query(`
      ALTER TABLE ${this.tables.agentSkills}
      ADD COLUMN IF NOT EXISTS load_count INTEGER NOT NULL DEFAULT 0
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

  async loadAgentSkill(agentKey: string, skillKey: string): Promise<AgentSkillRecord | null> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.agentSkills}
      SET
        last_loaded_at = NOW(),
        load_count = load_count + 1
      WHERE agent_key = $1
        AND skill_key = $2
      RETURNING *
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
}
