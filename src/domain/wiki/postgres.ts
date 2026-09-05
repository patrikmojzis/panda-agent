import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {normalizeAgentKey} from "../agents/types.js";
import {requirePostgresBuffer, requireTimestampMillis} from "../../lib/postgres-values.js";
import {buildWikiBindingTableNames} from "./postgres-shared.js";
import type {SetWikiBindingInput, WikiBindingRecord} from "./types.js";
import {normalizeWikiGroupId, normalizeWikiNamespacePath} from "./types.js";

export interface PostgresWikiBindingStoreOptions {
  pool: PgQueryable;
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
    apiTokenCiphertext: requirePostgresBuffer(row.api_token_ciphertext, "Wiki binding row is missing a binary field."),
    apiTokenIv: requirePostgresBuffer(row.api_token_iv, "Wiki binding row is missing a binary field."),
    apiTokenTag: requirePostgresBuffer(row.api_token_tag, "Wiki binding row is missing a binary field."),
    envelopeVersion: parsePositiveInteger(
      row.envelope_version,
      "Wiki binding envelope version must be a positive integer.",
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
        envelope_version
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
        envelope_version = EXCLUDED.envelope_version,
        updated_at = NOW()
      RETURNING *
    `, [
      normalizedAgentKey,
      wikiGroupId,
      namespacePath,
      input.encryptedApiToken.ciphertext,
      input.encryptedApiToken.iv,
      input.encryptedApiToken.tag,
      input.encryptedApiToken.envelopeVersion,
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
