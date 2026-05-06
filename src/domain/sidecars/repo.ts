import type {Pool} from "pg";

import type {JsonObject} from "../../kernel/agent/types.js";
import {
  CREATE_RUNTIME_SCHEMA_SQL,
  quoteIdentifier,
  toJson,
  toMillis,
} from "../threads/runtime/postgres-shared.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSidecarTableNames, type SidecarTableNames} from "./postgres-shared.js";
import {
  normalizeSidecarAgentKey,
  normalizeSidecarKey,
  normalizeSidecarPrompt,
  normalizeSidecarTriggers,
  type SidecarDefinitionRecord,
  type SidecarToolset,
  type SidecarTrigger,
  type UpsertSidecarDefinitionInput,
} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

export interface PostgresSidecarRepoOptions {
  pool: PgQueryable;
}

function parseSidecarRow(row: Record<string, unknown>): SidecarDefinitionRecord {
  return {
    agentKey: String(row.agent_key),
    sidecarKey: String(row.sidecar_key),
    displayName: String(row.display_name),
    enabled: Boolean(row.enabled),
    prompt: String(row.prompt),
    triggers: Array.isArray(row.triggers) ? row.triggers.map(String) as SidecarTrigger[] : [],
    model: row.model === null ? undefined : String(row.model),
    thinking: row.thinking === null ? undefined : row.thinking as SidecarDefinitionRecord["thinking"],
    toolset: String(row.toolset) as SidecarToolset,
    metadata: row.metadata === null ? undefined : row.metadata as JsonObject,
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

function normalizeInput(input: UpsertSidecarDefinitionInput): {
  agentKey: string;
  sidecarKey: string;
  displayName: string;
  enabled: boolean;
  prompt: string;
  triggers: readonly SidecarTrigger[];
  model: string | null;
  thinking: string | null;
  toolset: SidecarToolset;
  metadata: JsonObject | null;
} {
  const agentKey = normalizeSidecarAgentKey(input.agentKey);
  const sidecarKey = normalizeSidecarKey(input.sidecarKey);
  const displayName = input.displayName?.trim() || sidecarKey;
  return {
    agentKey,
    sidecarKey,
    displayName,
    enabled: input.enabled ?? true,
    prompt: normalizeSidecarPrompt(input.prompt),
    triggers: normalizeSidecarTriggers(input.triggers),
    model: input.model?.trim() || null,
    thinking: input.thinking ?? null,
    toolset: input.toolset ?? "readonly",
    metadata: input.metadata ?? null,
  };
}

function missingSidecarError(agentKey: string, sidecarKey: string): Error {
  return new Error(`Unknown sidecar ${agentKey}/${sidecarKey}.`);
}

export class PostgresSidecarRepo {
  private readonly pool: PgQueryable;
  private readonly tables: SidecarTableNames;
  private readonly agentTableName: string;

  constructor(options: PostgresSidecarRepoOptions) {
    this.pool = options.pool;
    this.tables = buildSidecarTableNames();
    this.agentTableName = buildAgentTableNames().agents;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.sidecars} (
        agent_key TEXT NOT NULL REFERENCES ${this.agentTableName}(agent_key) ON DELETE CASCADE,
        sidecar_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE,
        prompt TEXT NOT NULL,
        triggers JSONB NOT NULL DEFAULT '[]'::jsonb,
        model TEXT,
        thinking TEXT,
        toolset TEXT NOT NULL DEFAULT 'readonly',
        metadata JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (agent_key, sidecar_key)
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_sidecars_agent_enabled_idx`)}
      ON ${this.tables.sidecars} (agent_key, enabled, sidecar_key)
    `);
  }

  async upsertDefinition(input: UpsertSidecarDefinitionInput): Promise<SidecarDefinitionRecord> {
    const normalized = normalizeInput(input);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.sidecars} (
        agent_key,
        sidecar_key,
        display_name,
        enabled,
        prompt,
        triggers,
        model,
        thinking,
        toolset,
        metadata
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6::jsonb,
        $7,
        $8,
        $9,
        $10::jsonb
      )
      ON CONFLICT (agent_key, sidecar_key)
      DO UPDATE SET
        display_name = EXCLUDED.display_name,
        enabled = EXCLUDED.enabled,
        prompt = EXCLUDED.prompt,
        triggers = EXCLUDED.triggers,
        model = EXCLUDED.model,
        thinking = EXCLUDED.thinking,
        toolset = EXCLUDED.toolset,
        metadata = EXCLUDED.metadata,
        updated_at = NOW()
      RETURNING *
    `, [
      normalized.agentKey,
      normalized.sidecarKey,
      normalized.displayName,
      normalized.enabled,
      normalized.prompt,
      JSON.stringify(normalized.triggers),
      normalized.model,
      normalized.thinking,
      normalized.toolset,
      toJson(normalized.metadata),
    ]);

    return parseSidecarRow(result.rows[0] as Record<string, unknown>);
  }

  async listAgentDefinitions(
    agentKey: string,
    options: { enabled?: boolean } = {},
  ): Promise<readonly SidecarDefinitionRecord[]> {
    const normalizedAgentKey = normalizeSidecarAgentKey(agentKey);
    const clauses = ["agent_key = $1"];
    const values: unknown[] = [normalizedAgentKey];
    if (options.enabled !== undefined) {
      values.push(options.enabled);
      clauses.push(`enabled = $${values.length}`);
    }

    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sidecars}
      WHERE ${clauses.join(" AND ")}
      ORDER BY sidecar_key ASC
    `, values);

    return result.rows.map((row) => parseSidecarRow(row as Record<string, unknown>));
  }

  async getDefinition(agentKey: string, sidecarKey: string): Promise<SidecarDefinitionRecord> {
    const normalizedAgentKey = normalizeSidecarAgentKey(agentKey);
    const normalizedSidecarKey = normalizeSidecarKey(sidecarKey);
    const result = await this.pool.query(`
      SELECT *
      FROM ${this.tables.sidecars}
      WHERE agent_key = $1
        AND sidecar_key = $2
    `, [
      normalizedAgentKey,
      normalizedSidecarKey,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw missingSidecarError(normalizedAgentKey, normalizedSidecarKey);
    }

    return parseSidecarRow(row as Record<string, unknown>);
  }

  async setEnabled(agentKey: string, sidecarKey: string, enabled: boolean): Promise<SidecarDefinitionRecord> {
    const normalizedAgentKey = normalizeSidecarAgentKey(agentKey);
    const normalizedSidecarKey = normalizeSidecarKey(sidecarKey);
    const result = await this.pool.query(`
      UPDATE ${this.tables.sidecars}
      SET enabled = $3,
          updated_at = NOW()
      WHERE agent_key = $1
        AND sidecar_key = $2
      RETURNING *
    `, [
      normalizedAgentKey,
      normalizedSidecarKey,
      enabled,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw missingSidecarError(normalizedAgentKey, normalizedSidecarKey);
    }

    return parseSidecarRow(row as Record<string, unknown>);
  }

  async deleteDefinition(agentKey: string, sidecarKey: string): Promise<boolean> {
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.sidecars}
      WHERE agent_key = $1
        AND sidecar_key = $2
    `, [
      normalizeSidecarAgentKey(agentKey),
      normalizeSidecarKey(sidecarKey),
    ]);

    return (result.rowCount ?? 0) > 0;
  }
}
