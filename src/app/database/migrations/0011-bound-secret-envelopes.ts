import {createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes} from "node:crypto";

import type {PostgresMigration} from "../../../lib/postgres-migrations.js";
import type {PgQueryable} from "../../../lib/postgres-query.js";
import {PANDA_BOUND_SECRET_ENVELOPES} from "../../../integrations/postgres/schema-versions/0011-bound-secret-envelopes.js";

const AES_ALGORITHM = "aes-256-gcm";
const BATCH_SIZE = 200;
const DERIVATION_SALT = Buffer.from("panda-secret-envelope-v2", "utf8");

interface SecretTable {
  table: string;
  identityColumns: readonly string[];
  purpose: string;
  ciphertextColumn: string;
  ivColumn: string;
  tagColumn: string;
  constraint: string;
}

const SECRET_TABLES: readonly SecretTable[] = [
  {
    table: "credentials",
    identityColumns: ["agent_key", "env_key"],
    purpose: "agent-credential",
    ciphertextColumn: "value_ciphertext",
    ivColumn: "value_iv",
    tagColumn: "value_tag",
    constraint: "runtime_credentials_envelope_version_check",
  },
  {
    table: "connector_account_secrets",
    identityColumns: ["account_id", "secret_key"],
    purpose: "connector-account-secret",
    ciphertextColumn: "value_ciphertext",
    ivColumn: "value_iv",
    tagColumn: "value_tag",
    constraint: "runtime_connector_account_secrets_envelope_version_check",
  },
  {
    table: "whatsapp_account_auth_creds",
    identityColumns: ["account_id"],
    purpose: "whatsapp-auth-creds",
    ciphertextColumn: "value_ciphertext",
    ivColumn: "value_iv",
    tagColumn: "value_tag",
    constraint: "runtime_whatsapp_auth_creds_envelope_version_check",
  },
  {
    table: "whatsapp_account_auth_keys",
    identityColumns: ["account_id", "category", "key_id"],
    purpose: "whatsapp-auth-key",
    ciphertextColumn: "value_ciphertext",
    ivColumn: "value_iv",
    tagColumn: "value_tag",
    constraint: "runtime_whatsapp_auth_keys_envelope_version_check",
  },
  {
    table: "agent_wiki_bindings",
    identityColumns: ["agent_key"],
    purpose: "wiki-api-token",
    ciphertextColumn: "api_token_ciphertext",
    ivColumn: "api_token_iv",
    tagColumn: "api_token_tag",
    constraint: "runtime_agent_wiki_bindings_envelope_version_check",
  },
  {
    table: "agent_mcp_oauth_connections",
    identityColumns: ["agent_key", "server_name"],
    purpose: "mcp-oauth-connection",
    ciphertextColumn: "state_ciphertext",
    ivColumn: "state_iv",
    tagColumn: "state_tag",
    constraint: "runtime_agent_mcp_oauth_connections_envelope_version_check",
  },
  {
    table: "agent_mcp_oauth_attempts",
    identityColumns: ["state_hash", "agent_key", "server_name"],
    purpose: "mcp-oauth-attempt",
    ciphertextColumn: "verifier_ciphertext",
    ivColumn: "verifier_iv",
    tagColumn: "verifier_tag",
    constraint: "runtime_agent_mcp_oauth_attempts_envelope_version_check",
  },
] as const;

function binary(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") {
    return value.startsWith("\\x") ? Buffer.from(value.slice(2), "hex") : Buffer.from(value, "utf8");
  }
  throw new Error("Secret migration encountered a non-binary envelope field.");
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Secret migration encountered an empty identity field.");
  }
  return value;
}

function decode(value: unknown): Buffer {
  return Buffer.from(binary(value).toString("utf8"), "base64");
}

function openV1(row: Record<string, unknown>, rootKey: Buffer): string {
  const decipher = createDecipheriv(AES_ALGORITHM, rootKey, decode(row.iv));
  decipher.setAuthTag(decode(row.tag));
  return Buffer.concat([decipher.update(decode(row.ciphertext)), decipher.final()]).toString("utf8");
}

function sealV2(value: string, purpose: string, identity: readonly string[], rootKey: Buffer) {
  const iv = randomBytes(12);
  const key = Buffer.from(hkdfSync("sha256", rootKey, DERIVATION_SALT, Buffer.from(purpose, "utf8"), 32));
  const aad = Buffer.from(JSON.stringify(["panda-secret", 2, purpose, ...identity]), "utf8");
  const cipher = createCipheriv(AES_ALGORITHM, key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: Buffer.from(ciphertext.toString("base64"), "utf8"),
    iv: Buffer.from(iv.toString("base64"), "utf8"),
    tag: Buffer.from(cipher.getAuthTag().toString("base64"), "utf8"),
  };
}

async function assertOnlyV1(queryable: PgQueryable, table: SecretTable): Promise<void> {
  const result = await queryable.query(`
    SELECT DISTINCT "key_version" AS "version"
    FROM "runtime"."${table.table}"
    WHERE "key_version" <> 1
    LIMIT 1
  `);
  if (result.rows.length > 0) {
    throw new Error(`Secret migration found an unsupported envelope version in runtime.${table.table}.`);
  }
}

async function hasV1Rows(queryable: PgQueryable): Promise<boolean> {
  for (const table of SECRET_TABLES) {
    const result = await queryable.query(`
      SELECT 1
      FROM "runtime"."${table.table}"
      WHERE "key_version" = 1
      LIMIT 1
    `);
    if (result.rows.length > 0) return true;
  }
  return false;
}

async function rewrapTable(queryable: PgQueryable, table: SecretTable, rootKey: Buffer): Promise<void> {
  const identitySelect = table.identityColumns.map((column) => `"${column}"::text AS "${column}"`).join(", ");
  const orderBy = table.identityColumns.map((column) => `"${column}"`).join(", ");
  const identityWhere = table.identityColumns.map((column, index) => `"${column}"::text = $${index + 4}`).join(" AND ");

  while (true) {
    const result = await queryable.query(`
      SELECT ${identitySelect},
             "${table.ciphertextColumn}" AS "ciphertext",
             "${table.ivColumn}" AS "iv",
             "${table.tagColumn}" AS "tag"
      FROM "runtime"."${table.table}"
      WHERE "key_version" = 1
      ORDER BY ${orderBy}
      LIMIT ${BATCH_SIZE}
    `);
    if (result.rows.length === 0) return;

    for (const rawRow of result.rows) {
      const row = rawRow as Record<string, unknown>;
      const identity = table.identityColumns.map((column) => text(row[column]));
      const plaintext = openV1(row, rootKey);
      const encrypted = sealV2(plaintext, table.purpose, identity, rootKey);
      const updated = await queryable.query(`
        UPDATE "runtime"."${table.table}"
        SET "${table.ciphertextColumn}" = $1,
            "${table.ivColumn}" = $2,
            "${table.tagColumn}" = $3,
            "key_version" = 2
        WHERE ${identityWhere}
          AND "key_version" = 1
      `, [encrypted.ciphertext, encrypted.iv, encrypted.tag, ...identity]);
      if (updated.rowCount !== 1) {
        throw new Error(`Secret migration lost its stopped-writer invariant for runtime.${table.table}.`);
      }
    }
  }
}

/**
 * Rewraps every v1 secret before installing the v2-only schema. The cryptographic
 * code is intentionally frozen here so this migration's checksum cannot drift
 * when the steady-state SecretCrypto implementation changes later.
 */
export const BOUND_SECRET_ENVELOPES_MIGRATION: PostgresMigration = {
  ...PANDA_BOUND_SECRET_ENVELOPES,
  apply: async ({queryable}) => {
    await queryable.query(`
      DELETE FROM "runtime"."agent_mcp_oauth_attempts"
      WHERE "consumed_at" IS NOT NULL OR "expires_at" <= NOW()
    `);

    for (const table of SECRET_TABLES) await assertOnlyV1(queryable, table);

    if (await hasV1Rows(queryable)) {
      const masterKey = process.env.CREDENTIALS_MASTER_KEY?.trim();
      if (!masterKey) {
        throw new Error("CREDENTIALS_MASTER_KEY is required to migrate stored secret envelopes.");
      }
      const rootKey = createHash("sha256").update(masterKey, "utf8").digest();
      for (const table of SECRET_TABLES) await rewrapTable(queryable, table, rootKey);
    }

    for (const table of SECRET_TABLES) {
      await queryable.query(`
        ALTER TABLE "runtime"."${table.table}"
        RENAME COLUMN "key_version" TO "envelope_version";

        ALTER TABLE "runtime"."${table.table}"
        ADD CONSTRAINT "${table.constraint}"
        CHECK ("envelope_version" >= 2);
      `);
    }
  },
};
