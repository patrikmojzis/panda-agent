import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {normalizeAgentKey} from "../agents/types.js";
import {requireTimestampMillis} from "../../lib/postgres-values.js";
import {ensurePostgresWikiBindingSchema} from "./postgres-schema.js";
import {buildWikiBindingTableNames} from "./postgres-shared.js";
import type {SetWikiBindingInput, WikiBindingRecord} from "./types.js";
import {normalizeWikiGroupId, normalizeWikiNamespacePath} from "./types.js";

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

function parsePositiveInteger(value: unknown, errorMessage: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(errorMessage);
  }

  return value;
}

function parseWikiBindingRow(row: Record<string, unknown>): WikiBindingRecord {
  return {
    agentKey: normalizeAgentKey(
      requireNonEmptyString(row.agent_key, "Wiki binding row is missing agent key."),
    ),
    wikiGroupId: normalizeWikiGroupId(parsePositiveInteger(
      row.wiki_group_id,
      "Wiki group id must be a positive integer.",
    )),
    namespacePath: normalizeWikiNamespacePath(
      requireNonEmptyString(row.namespace_path, "Wiki binding row is missing namespace path."),
    ),
    apiTokenCiphertext: toBuffer(row.api_token_ciphertext),
    apiTokenIv: toBuffer(row.api_token_iv),
    apiTokenTag: toBuffer(row.api_token_tag),
    keyVersion: parsePositiveInteger(
      row.key_version,
      "Wiki binding key version must be a positive integer.",
    ),
    createdAt: requireTimestampMillis(row.created_at, "Wiki binding created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Wiki binding updated_at must be a valid timestamp."),
  };
}

export class PostgresWikiBindingStore {
  private readonly pool: PgQueryable;
  private readonly tables = buildWikiBindingTableNames();

  constructor(options: PostgresWikiBindingStoreOptions) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresWikiBindingSchema(this.pool);
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
