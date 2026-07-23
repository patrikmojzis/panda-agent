import type {PgPoolLike} from "../../lib/postgres-query.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {normalizeAgentKey} from "../agents/types.js";
import type {EncryptedCredentialValue} from "../credentials/types.js";
import {isSafeMcpServerName} from "./config.js";
import type {McpOAuthAttemptRecord, McpOAuthConnectionRecord} from "./oauth-types.js";
import {ensurePostgresMcpSchema} from "./postgres-schema.js";
import {buildMcpTableNames} from "./postgres-shared.js";

function binary(value: unknown, label: string): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === "string") return value.startsWith("\\x")
    ? Buffer.from(value.slice(2), "hex")
    : Buffer.from(value, "utf8");
  throw new Error(`${label} must be binary.`);
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer.`);
  return parsed;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  return requireNonEmptyString(value, `${label} must be a non-empty string.`);
}

function encrypted(row: Record<string, unknown>, prefix: "state" | "verifier"): EncryptedCredentialValue {
  return {
    ciphertext: binary(row[`${prefix}_ciphertext`], `MCP OAuth ${prefix} ciphertext`),
    iv: binary(row[`${prefix}_iv`], `MCP OAuth ${prefix} IV`),
    tag: binary(row[`${prefix}_tag`], `MCP OAuth ${prefix} tag`),
    keyVersion: positiveInteger(row.key_version, "MCP OAuth key version"),
  };
}

function serverName(value: unknown): string {
  const normalized = requireNonEmptyString(value, "MCP OAuth server name is required.");
  if (!isSafeMcpServerName(normalized)) throw new Error("MCP OAuth server name is invalid.");
  return normalized;
}

function parseConnection(row: Record<string, unknown>): McpOAuthConnectionRecord {
  return {
    agentKey: normalizeAgentKey(requireNonEmptyString(row.agent_key, "MCP OAuth agent key is required.")),
    serverName: serverName(row.server_name),
    resourceUrl: optionalString(row.resource_url, "MCP OAuth resource URL"),
    authorizationServerUrl: optionalString(row.authorization_server_url, "MCP OAuth authorization server URL"),
    encryptedState: encrypted(row, "state"),
    version: positiveInteger(row.version, "MCP OAuth connection version"),
    authorizedAt: optionalTimestampMillis(row.authorized_at, "MCP OAuth authorized_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "MCP OAuth created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "MCP OAuth updated_at must be a valid timestamp."),
  };
}

function parseAttempt(row: Record<string, unknown>): McpOAuthAttemptRecord {
  return {
    stateHash: requireNonEmptyString(row.state_hash, "MCP OAuth state hash is required."),
    agentKey: normalizeAgentKey(requireNonEmptyString(row.agent_key, "MCP OAuth agent key is required.")),
    serverName: serverName(row.server_name),
    encryptedVerifier: encrypted(row, "verifier"),
    initiatedIdentityId: requireNonEmptyString(row.initiated_identity_id, "MCP OAuth initiating identity is required."),
    initiatedSessionId: requireNonEmptyString(row.initiated_session_id, "MCP OAuth initiating session is required."),
    expiresAt: requireTimestampMillis(row.expires_at, "MCP OAuth expires_at must be a valid timestamp."),
    consumedAt: optionalTimestampMillis(row.consumed_at, "MCP OAuth consumed_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "MCP OAuth attempt created_at must be a valid timestamp."),
  };
}

export class PostgresMcpOAuthStore {
  private readonly tables = buildMcpTableNames();

  constructor(private readonly pool: PgPoolLike) {}

  async ensureSchema(): Promise<void> {
    await ensurePostgresMcpSchema(this.pool);
  }

  async getConnection(agentKey: string, name: string): Promise<McpOAuthConnectionRecord | null> {
    const result = await this.pool.query(`SELECT * FROM ${this.tables.oauthConnections} WHERE agent_key = $1 AND server_name = $2`, [normalizeAgentKey(agentKey), serverName(name)]);
    return result.rows[0] ? parseConnection(result.rows[0] as Record<string, unknown>) : null;
  }

  async compareAndSetConnection(input: {
    agentKey: string;
    serverName: string;
    resourceUrl?: string;
    authorizationServerUrl?: string;
    encryptedState: EncryptedCredentialValue;
    expectedVersion: number | null;
    authorizedAt?: number;
  }): Promise<McpOAuthConnectionRecord | null> {
    const params = [normalizeAgentKey(input.agentKey), serverName(input.serverName), input.resourceUrl ?? null, input.authorizationServerUrl ?? null,
      input.encryptedState.ciphertext, input.encryptedState.iv, input.encryptedState.tag, input.encryptedState.keyVersion,
      input.authorizedAt === undefined ? null : new Date(input.authorizedAt)];
    const result = input.expectedVersion === null
      ? await this.pool.query(`
          INSERT INTO ${this.tables.oauthConnections} (
            agent_key, server_name, resource_url, authorization_server_url,
            state_ciphertext, state_iv, state_tag, key_version, authorized_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (agent_key, server_name) DO NOTHING
          RETURNING *
        `, params)
      : await this.pool.query(`
          UPDATE ${this.tables.oauthConnections}
          SET resource_url=$3, authorization_server_url=$4,
              state_ciphertext=$5, state_iv=$6, state_tag=$7, key_version=$8,
              authorized_at=$9, version=version+1, updated_at=NOW()
          WHERE agent_key=$1 AND server_name=$2 AND version=$10
          RETURNING *
        `, [...params, input.expectedVersion]);
    return result.rows[0] ? parseConnection(result.rows[0] as Record<string, unknown>) : null;
  }

  async deleteConnection(agentKey: string, name: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM ${this.tables.oauthConnections} WHERE agent_key=$1 AND server_name=$2`, [normalizeAgentKey(agentKey), serverName(name)]);
    return (result.rowCount ?? 0) > 0;
  }

  async createAttempt(input: {
    stateHash: string;
    agentKey: string;
    serverName: string;
    encryptedVerifier: EncryptedCredentialValue;
    initiatedIdentityId: string;
    initiatedSessionId: string;
    expiresAt: number;
  }): Promise<McpOAuthAttemptRecord> {
    const result = await this.pool.query(`
      INSERT INTO ${this.tables.oauthAttempts} (
        state_hash, agent_key, server_name, verifier_ciphertext, verifier_iv, verifier_tag,
        key_version, initiated_identity_id, initiated_session_id, expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (agent_key, server_name) DO UPDATE SET
        state_hash=EXCLUDED.state_hash,
        verifier_ciphertext=EXCLUDED.verifier_ciphertext,
        verifier_iv=EXCLUDED.verifier_iv,
        verifier_tag=EXCLUDED.verifier_tag,
        key_version=EXCLUDED.key_version,
        initiated_identity_id=EXCLUDED.initiated_identity_id,
        initiated_session_id=EXCLUDED.initiated_session_id,
        expires_at=EXCLUDED.expires_at,
        consumed_at=NULL,
        created_at=NOW()
      RETURNING *
    `, [input.stateHash, normalizeAgentKey(input.agentKey), serverName(input.serverName), input.encryptedVerifier.ciphertext,
      input.encryptedVerifier.iv, input.encryptedVerifier.tag, input.encryptedVerifier.keyVersion,
      requireNonEmptyString(input.initiatedIdentityId, "MCP OAuth initiating identity is required."),
      requireNonEmptyString(input.initiatedSessionId, "MCP OAuth initiating session is required."), new Date(input.expiresAt)]);
    return parseAttempt(result.rows[0] as Record<string, unknown>);
  }

  async consumeAttempt(stateHash: string, now: number): Promise<McpOAuthAttemptRecord | null> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.oauthAttempts}
      SET consumed_at=NOW()
      WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at > $2
      RETURNING *
    `, [requireNonEmptyString(stateHash, "MCP OAuth state hash is required."), new Date(now)]);
    return result.rows[0] ? parseAttempt(result.rows[0] as Record<string, unknown>) : null;
  }

  async hasActiveAttempt(agentKey: string, name: string, now: number): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM ${this.tables.oauthAttempts} WHERE agent_key=$1 AND server_name=$2 AND consumed_at IS NULL AND expires_at > $3 LIMIT 1`, [normalizeAgentKey(agentKey), serverName(name), new Date(now)]);
    return result.rows.length > 0;
  }
}
