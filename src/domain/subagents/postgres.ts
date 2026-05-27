import type {ThinkingLevel} from "@mariozechner/pi-ai";

import {readOptionalJsonValue} from "../../lib/json.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {requireTimestampMillis, toJson} from "../../lib/postgres-values.js";
import {optionalTrimmedString, requireNonEmptyString} from "../../lib/strings.js";
import {requireBoolean} from "../../lib/booleans.js";
import {normalizeAgentKey} from "../agents/types.js";
import {BUILTIN_SUBAGENT_PROFILES} from "./builtins.js";
import {ensurePostgresSubagentSchema} from "./postgres-schema.js";
import {buildSubagentTableNames, type SubagentTableNames} from "./postgres-shared.js";
import type {SubagentProfileStore} from "./store.js";
import {
  normalizeSubagentProfileDescription,
  normalizeSubagentProfileInput,
  normalizeSubagentProfilePrompt,
  normalizeSubagentProfileSlug,
  parseSubagentProfileSource,
  parseSubagentProfileThinking,
  parseSubagentProfileTranscriptMode,
  type GetSubagentProfileInput,
  type ListSubagentProfilesInput,
  type NormalizedSubagentProfileInput,
  type SubagentProfileRecord,
  type UpsertSubagentProfileInput,
} from "./types.js";
import {normalizeSubagentToolGroups} from "./tool-groups.js";

export interface PostgresSubagentProfileStoreOptions {
  pool: PgPoolLike;
}

function parseOptionalText(value: unknown, field: string): string | undefined {
  return optionalTrimmedString(value, `Subagent profile ${field} must be a string.`);
}

function parseToolGroups(value: unknown): SubagentProfileRecord["toolGroups"] {
  const json = readOptionalJsonValue(value, "Subagent profile tool groups");
  if (!Array.isArray(json)) {
    throw new Error("Subagent profile tool groups must be a JSON array.");
  }
  if (!json.every((entry): entry is string => typeof entry === "string")) {
    throw new Error("Subagent profile tool groups must contain only strings.");
  }

  return normalizeSubagentToolGroups(json);
}

function parseProfileRow(row: Record<string, unknown>): SubagentProfileRecord {
  return {
    slug: normalizeSubagentProfileSlug(
      requireNonEmptyString(row.slug, "Subagent profile row is missing slug."),
    ),
    agentKey: parseOptionalText(row.agent_key, "agent_key"),
    description: normalizeSubagentProfileDescription(
      requireNonEmptyString(row.description, "Subagent profile row is missing description."),
    ),
    prompt: normalizeSubagentProfilePrompt(
      requireNonEmptyString(row.prompt, "Subagent profile row is missing prompt."),
    ),
    toolGroups: parseToolGroups(row.tool_groups),
    model: parseOptionalText(row.model, "model"),
    thinking: parseSubagentProfileThinking(row.thinking) as ThinkingLevel | undefined,
    transcriptMode: parseSubagentProfileTranscriptMode(row.transcript_mode),
    source: parseSubagentProfileSource(row.source),
    createdByAgentKey: parseOptionalText(row.created_by_agent_key, "created_by_agent_key"),
    enabled: requireBoolean(row.enabled, "Subagent profile enabled must be a boolean."),
    createdAt: requireTimestampMillis(row.created_at, "Subagent profile created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Subagent profile updated_at must be a valid timestamp."),
  };
}

function profileParams(profile: NormalizedSubagentProfileInput): unknown[] {
  return [
    profile.slug,
    profile.agentKey ?? null,
    profile.description,
    profile.prompt,
    toJson(profile.toolGroups),
    profile.model ?? null,
    profile.thinking ?? null,
    profile.transcriptMode,
    profile.source,
    profile.createdByAgentKey ?? null,
    profile.enabled,
  ];
}

export class PostgresSubagentProfileStore implements SubagentProfileStore {
  private readonly pool: PgPoolLike;
  private readonly tables: SubagentTableNames;

  constructor(options: PostgresSubagentProfileStoreOptions) {
    this.pool = options.pool;
    this.tables = buildSubagentTableNames();
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresSubagentSchema(this.pool);
  }

  async seedBuiltinProfiles(
    profiles: readonly UpsertSubagentProfileInput[] = BUILTIN_SUBAGENT_PROFILES,
  ): Promise<readonly SubagentProfileRecord[]> {
    const seeded: SubagentProfileRecord[] = [];
    for (const profile of profiles) {
      seeded.push(await this.upsertProfile(profile));
    }
    return seeded;
  }

  async upsertProfile(input: UpsertSubagentProfileInput): Promise<SubagentProfileRecord> {
    const profile = normalizeSubagentProfileInput(input);
    await this.assertNoCustomBuiltinSlugConflict(profile);

    const lookup = profile.agentKey === undefined
      ? await this.pool.query(
        `SELECT slug FROM ${this.tables.subagentProfiles} WHERE slug = $1 AND agent_key IS NULL LIMIT 1`,
        [profile.slug],
      )
      : await this.pool.query(
        `SELECT slug FROM ${this.tables.subagentProfiles} WHERE slug = $1 AND agent_key = $2 LIMIT 1`,
        [profile.slug, profile.agentKey],
      );

    const params = profileParams(profile);
    const result = lookup.rows.length > 0
      ? await this.updateProfile(profile, params)
      : await this.insertProfile(params);

    return parseProfileRow(result.rows[0] as Record<string, unknown>);
  }

  async getProfile(input: GetSubagentProfileInput): Promise<SubagentProfileRecord | null> {
    const slug = normalizeSubagentProfileSlug(input.slug);
    const includeDisabled = input.includeDisabled === true;
    const enabledSql = includeDisabled ? "" : "AND enabled = TRUE";
    const agentKey = input.agentKey ? normalizeAgentKey(input.agentKey) : undefined;
    const result = agentKey
      ? await this.pool.query(`
        SELECT *
        FROM ${this.tables.subagentProfiles}
        WHERE slug = $1
          AND (agent_key IS NULL OR agent_key = $2)
          ${enabledSql}
        LIMIT 1
      `, [slug, agentKey])
      : await this.pool.query(`
        SELECT *
        FROM ${this.tables.subagentProfiles}
        WHERE slug = $1
          AND agent_key IS NULL
          ${enabledSql}
        LIMIT 1
      `, [slug]);

    const row = result.rows[0];
    return row ? parseProfileRow(row as Record<string, unknown>) : null;
  }

  async listProfiles(input: ListSubagentProfilesInput = {}): Promise<readonly SubagentProfileRecord[]> {
    const includeDisabled = input.includeDisabled === true;
    const enabledSql = includeDisabled ? "" : "AND enabled = TRUE";
    const agentKey = input.agentKey ? normalizeAgentKey(input.agentKey) : undefined;
    const result = agentKey
      ? await this.pool.query(`
        SELECT *
        FROM ${this.tables.subagentProfiles}
        WHERE (agent_key IS NULL OR agent_key = $1)
          ${enabledSql}
        ORDER BY slug ASC, agent_key ASC
      `, [agentKey])
      : await this.pool.query(`
        SELECT *
        FROM ${this.tables.subagentProfiles}
        WHERE agent_key IS NULL
          ${enabledSql}
        ORDER BY slug ASC
      `);

    return result.rows.map((row) => parseProfileRow(row as Record<string, unknown>));
  }

  private async assertNoCustomBuiltinSlugConflict(profile: NormalizedSubagentProfileInput): Promise<void> {
    if (profile.source !== "custom") {
      return;
    }

    const existingBuiltin = await this.pool.query(
      `SELECT slug FROM ${this.tables.subagentProfiles} WHERE slug = $1 AND agent_key IS NULL LIMIT 1`,
      [profile.slug],
    );
    if (existingBuiltin.rows.length > 0) {
      throw new Error(`Custom subagent profile ${profile.slug} conflicts with a built-in profile slug.`);
    }
  }

  private async insertProfile(params: readonly unknown[]): Promise<{ rows: readonly unknown[] }> {
    return this.pool.query(`
      INSERT INTO ${this.tables.subagentProfiles} (
        slug,
        agent_key,
        description,
        prompt,
        tool_groups,
        model,
        thinking,
        transcript_mode,
        source,
        created_by_agent_key,
        enabled
      ) VALUES (
        $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11
      )
      RETURNING *
    `, params);
  }

  private async updateProfile(
    profile: NormalizedSubagentProfileInput,
    params: readonly unknown[],
  ): Promise<{ rows: readonly unknown[] }> {
    const whereSql = profile.agentKey === undefined
      ? "slug = $1 AND agent_key IS NULL"
      : "slug = $1 AND agent_key = $2";
    return this.pool.query(`
      UPDATE ${this.tables.subagentProfiles}
      SET
        description = $3,
        prompt = $4,
        tool_groups = $5::jsonb,
        model = $6,
        thinking = $7,
        transcript_mode = $8,
        source = $9,
        created_by_agent_key = $10,
        enabled = $11,
        updated_at = NOW()
      WHERE ${whereSql}
      RETURNING *
    `, params);
  }
}
