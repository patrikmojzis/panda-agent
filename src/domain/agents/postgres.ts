import {readOptionalJsonValue, stringifyOptionalJsonValue} from "../../lib/json.js";
import {requireNonNegativeInteger} from "../../lib/numbers.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {buildAgentTableNames, type AgentTableNames} from "./postgres-shared.js";
import {
  ensurePostgresAgentSchema,
  ensurePostgresAgentTableSchema,
} from "./postgres-schema.js";
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
  normalizeAgentSkillTags,
  normalizePersistedAgentSkillDescription,
  normalizeSkillKey,
} from "./types.js";

export interface PostgresAgentStoreOptions {
  pool: PgPoolLike;
}

function parseAgentStatus(value: unknown): AgentRecord["status"] {
  if (value === "active" || value === "deleted") {
    return value;
  }

  throw new Error(`Unsupported agent status ${String(value)}.`);
}

function parseAgentPromptSlug(value: unknown): AgentPromptSlug {
  if (value === "agent" || value === "heartbeat") {
    return value;
  }

  throw new Error(`Unsupported agent prompt slug ${String(value)}.`);
}

function parseString(value: unknown, errorMessage: string): string {
  if (typeof value !== "string") {
    throw new Error(errorMessage);
  }

  return value;
}

function parseAgentRow(row: Record<string, unknown>): AgentRecord {
  return {
    agentKey: normalizeAgentKey(
      requireNonEmptyString(row.agent_key, "Agent row is missing agent key."),
    ),
    displayName: requireNonEmptyString(row.display_name, "Agent row is missing display name."),
    status: parseAgentStatus(row.status),
    metadata: readOptionalJsonValue(row.metadata, "Agent metadata"),
    createdAt: requireTimestampMillis(row.created_at, "Agent created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Agent updated_at must be a valid timestamp."),
  };
}

function parseAgentPromptRow(row: Record<string, unknown>): AgentPromptRecord {
  return {
    agentKey: normalizeAgentKey(
      requireNonEmptyString(row.agent_key, "Agent prompt row is missing agent key."),
    ),
    slug: parseAgentPromptSlug(row.slug),
    content: parseString(row.content, "Agent prompt row is missing content."),
    createdAt: requireTimestampMillis(row.created_at, "Agent prompt created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Agent prompt updated_at must be a valid timestamp."),
  };
}

function parseAgentSkillTags(value: unknown): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Agent skill tags must be an array of strings.");
  }
  return normalizeAgentSkillTags(value);
}

function parseAgentSkillRow(row: Record<string, unknown>): AgentSkillRecord {
  return {
    agentKey: normalizeAgentKey(
      requireNonEmptyString(row.agent_key, "Agent skill row is missing agent key."),
    ),
    skillKey: normalizeSkillKey(
      requireNonEmptyString(row.skill_key, "Agent skill row is missing skill key."),
    ),
    description: normalizePersistedAgentSkillDescription(
      requireNonEmptyString(row.description, "Agent skill row is missing description."),
    ),
    content: normalizeAgentSkillContent(
      requireNonEmptyString(row.content, "Agent skill row is missing content."),
    ),
    tags: parseAgentSkillTags(row.tags),
    lastLoadedAt: optionalTimestampMillis(row.last_loaded_at, "Agent skill last_loaded_at must be a valid timestamp."),
    loadCount: requireNonNegativeInteger(row.load_count ?? 0, "Agent skill load count"),
    createdAt: requireTimestampMillis(row.created_at, "Agent skill created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Agent skill updated_at must be a valid timestamp."),
  };
}

function parseAgentPairingRow(row: Record<string, unknown>): AgentPairingRecord {
  return {
    agentKey: normalizeAgentKey(
      requireNonEmptyString(row.agent_key, "Agent pairing row is missing agent key."),
    ),
    identityId: requireIdentityId(
      requireNonEmptyString(row.identity_id, "Agent pairing row is missing identity id."),
    ),
    metadata: readOptionalJsonValue(row.metadata, "Agent pairing metadata"),
    createdAt: requireTimestampMillis(row.created_at, "Agent pairing created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Agent pairing updated_at must be a valid timestamp."),
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

  constructor(options: PostgresAgentStoreOptions) {
    this.pool = options.pool;
    this.tables = buildAgentTableNames();
  }

  async ensureAgentTableSchema(): Promise<void> {
    await ensurePostgresAgentTableSchema(this.pool);
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresAgentSchema(this.pool);
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
        parseAgentStatus(input.status ?? "active"),
        stringifyOptionalJsonValue(input.metadata, "Agent metadata"),
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

  async setAgentSkill(agentKey: string, skillKey: string, description: string, content: string, tags: readonly unknown[] = []): Promise<AgentSkillRecord> {
    const normalizedTags = normalizeAgentSkillTags(tags);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.agentSkills} (
        agent_key,
        skill_key,
        description,
        content,
        tags
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5::text[]
      )
      ON CONFLICT (agent_key, skill_key)
      DO UPDATE SET
        description = EXCLUDED.description,
        content = EXCLUDED.content,
        tags = EXCLUDED.tags,
        updated_at = NOW()
      RETURNING *
    `, [
      normalizeAgentKey(agentKey),
      normalizeSkillKey(skillKey),
      normalizeAgentSkillDescription(description),
      normalizeAgentSkillContent(content),
      normalizedTags,
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
