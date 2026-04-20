import type {Pool} from "pg";

import {normalizeAgentKey} from "../agents/types.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildRuntimeRelationNames, CREATE_RUNTIME_SCHEMA_SQL, toMillis,} from "../threads/runtime/postgres-shared.js";
import type {SetWikiBindingInput, WikiBindingRecord} from "./types.js";
import {normalizeWikiGroupId, normalizeWikiNamespacePath} from "./types.js";

interface PgQueryable {
  query: Pool["query"];
}

export interface PostgresWikiBindingStoreOptions {
  pool: PgQueryable;
}

function toBuffer(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (typeof value === "string") {
    if (value.startsWith("\\x")) {
      return Buffer.from(value.slice(2), "hex");
    }

    return Buffer.from(value, "utf8");
  }

  throw new Error("Wiki binding row is missing a binary field.");
}

function parseWikiBindingRow(row: Record<string, unknown>): WikiBindingRecord {
  return {
    agentKey: String(row.agent_key),
    wikiGroupId: Number(row.wiki_group_id),
    namespacePath: String(row.namespace_path),
    apiTokenCiphertext: toBuffer(row.api_token_ciphertext),
    apiTokenIv: toBuffer(row.api_token_iv),
    apiTokenTag: toBuffer(row.api_token_tag),
    keyVersion: Number(row.key_version),
    createdAt: toMillis(row.created_at),
    updatedAt: toMillis(row.updated_at),
  };
}

export class PostgresWikiBindingStore {
  private readonly pool: PgQueryable;
  private readonly tables = buildRuntimeRelationNames({
    wikiBindings: "agent_wiki_bindings",
  });
  private readonly agentTables = buildAgentTableNames();

  constructor(options: PostgresWikiBindingStoreOptions) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.wikiBindings} (
        agent_key TEXT PRIMARY KEY REFERENCES ${this.agentTables.agents}(agent_key) ON DELETE CASCADE,
        wiki_group_id INTEGER NOT NULL,
        namespace_path TEXT NOT NULL,
        api_token_ciphertext BYTEA NOT NULL,
        api_token_iv BYTEA NOT NULL,
        api_token_tag BYTEA NOT NULL,
        key_version SMALLINT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (wiki_group_id > 0),
        CHECK (namespace_path <> '')
      )
    `);
  }

  async getBinding(agentKey: string, queryable: PgQueryable = this.pool): Promise<WikiBindingRecord | null> {
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const result = await queryable.query(`
      SELECT *
      FROM ${this.tables.wikiBindings}
      WHERE agent_key = $1
      LIMIT 1
    `, [normalizedAgentKey]);

    const row = result.rows[0];
    return row ? parseWikiBindingRow(row as Record<string, unknown>) : null;
  }

  async setBinding(input: SetWikiBindingInput): Promise<WikiBindingRecord> {
    const normalizedAgentKey = normalizeAgentKey(input.agentKey);
    const wikiGroupId = normalizeWikiGroupId(input.wikiGroupId);
    const namespacePath = normalizeWikiNamespacePath(input.namespacePath);
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.wikiBindings} (
        agent_key,
        wiki_group_id,
        namespace_path,
        api_token_ciphertext,
        api_token_iv,
        api_token_tag,
        key_version
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7
      )
      ON CONFLICT (agent_key) DO UPDATE
      SET
        wiki_group_id = EXCLUDED.wiki_group_id,
        namespace_path = EXCLUDED.namespace_path,
        api_token_ciphertext = EXCLUDED.api_token_ciphertext,
        api_token_iv = EXCLUDED.api_token_iv,
        api_token_tag = EXCLUDED.api_token_tag,
        key_version = EXCLUDED.key_version,
        updated_at = NOW()
      RETURNING *
    `, [
      normalizedAgentKey,
      wikiGroupId,
      namespacePath,
      input.encryptedApiToken.ciphertext,
      input.encryptedApiToken.iv,
      input.encryptedApiToken.tag,
      input.encryptedApiToken.keyVersion,
    ]);

    return parseWikiBindingRow(result.rows[0] as Record<string, unknown>);
  }

  async deleteBinding(agentKey: string): Promise<boolean> {
    const normalizedAgentKey = normalizeAgentKey(agentKey);
    const result = await this.pool.query(`
      DELETE FROM ${this.tables.wikiBindings}
      WHERE agent_key = $1
    `, [normalizedAgentKey]);
    return (result.rowCount ?? 0) > 0;
  }
}
