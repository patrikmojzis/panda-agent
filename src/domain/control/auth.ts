import {randomUUID} from "node:crypto";

import {generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches} from "../../lib/opaque-tokens.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {optionalTimestampMillis, requireTimestampMillis} from "../../lib/postgres-values.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {normalizeAgentKey} from "../agents/types.js";
import {ensurePostgresControlSchema} from "./postgres-schema.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlGrantRecord, ControlGrantRole, ControlLoginResult, ControlSessionRecord} from "./types.js";

export const DEFAULT_CONTROL_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const DEFAULT_CONTROL_REMEMBERED_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_CONTROL_LOGIN_TOKEN_TTL_MS = 15 * 60 * 1000;

function parseRole(value: unknown): ControlGrantRole {
  if (value === "admin" || value === "scoped") return value;
  throw new Error(`Unsupported Control role ${String(value)}.`);
}

function parseGrant(row: Record<string, unknown>): ControlGrantRecord {
  const agentKey = typeof row.agent_key === "string" && row.agent_key ? normalizeAgentKey(row.agent_key) : undefined;
  return {
    id: requireNonEmptyString(row.id, "Control grant id is missing."),
    identityId: requireNonEmptyString(row.identity_id, "Control grant identity id is missing."),
    role: parseRole(row.role),
    ...(agentKey ? {agentKey} : {}),
    label: typeof row.label === "string" && row.label ? row.label : undefined,
    active: row.active === true,
    loginTokenExpiresAt: requireTimestampMillis(row.login_token_expires_at, "Control grant login_token_expires_at must be a valid timestamp."),
    loginTokenConsumedAt: optionalTimestampMillis(row.login_token_consumed_at, "Control grant login_token_consumed_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "Control grant created_at must be a valid timestamp."),
    updatedAt: requireTimestampMillis(row.updated_at, "Control grant updated_at must be a valid timestamp."),
  };
}

function parseSession(row: Record<string, unknown>): ControlSessionRecord {
  return {
    id: requireNonEmptyString(row.id, "Control session id is missing."),
    identityId: requireNonEmptyString(row.identity_id, "Control session identity id is missing."),
    role: parseRole(row.role),
    csrfTokenHash: requireNonEmptyString(row.csrf_token_hash, "Control session CSRF hash is missing."),
    expiresAt: requireTimestampMillis(row.expires_at, "Control session expires_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "Control session created_at must be a valid timestamp."),
    lastSeenAt: requireTimestampMillis(row.last_seen_at, "Control session last_seen_at must be a valid timestamp."),
  };
}

export class PostgresControlAuthService {
  private readonly pool: PgPoolLike;
  private readonly tables = buildControlTableNames();

  constructor(options: {pool: PgPoolLike}) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresControlSchema(this.pool);
  }

  async createGrant(input: {identityId: string; role: ControlGrantRole; agentKey?: string; label?: string; loginTokenTtlMs?: number}): Promise<{grant: ControlGrantRecord; loginToken: string}> {
    const token = generateOpaqueToken("pct");
    const role = parseRole(input.role);
    const agentKey = role === "scoped" ? normalizeAgentKey(requireNonEmptyString(input.agentKey, "Scoped Control grants require an agent key.")) : null;
    if (role === "admin" && input.agentKey) throw new Error("Admin Control grants must not specify an agent key.");
    const expiresAt = Date.now() + (input.loginTokenTtlMs ?? DEFAULT_CONTROL_LOGIN_TOKEN_TTL_MS);
    const inserted = await this.pool.query(`
      INSERT INTO ${this.tables.grants} (id, identity_id, role, agent_key, label, login_token_hash, login_token_expires_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [randomUUID(), requireNonEmptyString(input.identityId, "Identity id is required."), role, agentKey, input.label?.trim() || null, hashOpaqueToken(token), new Date(expiresAt)]);
    return {grant: parseGrant(inserted.rows[0] as Record<string, unknown>), loginToken: token};
  }

  async listGrants(): Promise<readonly ControlGrantRecord[]> {
    const result = await this.pool.query(`SELECT * FROM ${this.tables.grants} ORDER BY created_at ASC`);
    return result.rows.map((row) => parseGrant(row as Record<string, unknown>));
  }

  async hasAnyGrant(): Promise<boolean> {
    const result = await this.pool.query(`SELECT 1 FROM ${this.tables.grants} WHERE active = TRUE LIMIT 1`);
    return result.rows.length > 0;
  }

  async loginWithToken(token: string, options: {sessionTtlMs?: number; remember?: boolean} = {}): Promise<ControlLoginResult> {
    const sessionToken = generateOpaqueToken("pcs");
    const csrfToken = generateOpaqueToken("pcc");
    const remember = options.remember === true;
    const expiresAt = Date.now() + (options.sessionTtlMs ?? (remember ? DEFAULT_CONTROL_REMEMBERED_SESSION_TTL_MS : DEFAULT_CONTROL_SESSION_TTL_MS));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const consumed = await client.query(`
        UPDATE ${this.tables.grants}
        SET login_token_consumed_at = NOW(), updated_at = NOW()
        WHERE login_token_hash = $1
          AND active = TRUE
          AND login_token_consumed_at IS NULL
          AND login_token_expires_at > NOW()
        RETURNING *
      `, [hashOpaqueToken(requireNonEmptyString(token, "Control login token is required."))]);
      const grant = consumed.rows[0] ? parseGrant(consumed.rows[0] as Record<string, unknown>) : null;
      if (!grant) {
        await client.query("ROLLBACK");
        throw new Error("Control login token is invalid, expired, or already used.");
      }
      const inserted = await client.query(`
        INSERT INTO ${this.tables.sessions} (id, session_token_hash, csrf_token_hash, identity_id, role, expires_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *
      `, [randomUUID(), hashOpaqueToken(sessionToken), hashOpaqueToken(csrfToken), grant.identityId, grant.role, new Date(expiresAt)]);
      const session = parseSession(inserted.rows[0] as Record<string, unknown>);
      await client.query(`
        INSERT INTO ${this.tables.auditEvents} (id, identity_id, session_id, event_type, metadata)
        VALUES ($1, $2, $3, $4, $5::jsonb)
      `, [randomUUID(), session.identityId, session.id, "login", remember ? JSON.stringify({remembered: true}) : null]);
      await client.query("COMMIT");
      return {session, sessionToken, csrfToken};
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getSessionByToken(token: string): Promise<ControlSessionRecord | null> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.sessions}
      SET last_seen_at = NOW()
      WHERE session_token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()
      RETURNING *
    `, [hashOpaqueToken(requireNonEmptyString(token, "Control session token is required."))]);
    return result.rows[0] ? parseSession(result.rows[0] as Record<string, unknown>) : null;
  }

  verifyCsrfToken(session: ControlSessionRecord, token: string): boolean {
    return opaqueTokenMatches(token, session.csrfTokenHash);
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query(`UPDATE ${this.tables.sessions} SET revoked_at = NOW() WHERE id = $1`, [sessionId]);
  }

  async recordAudit(input: {identityId?: string; sessionId?: string; eventType: string; metadata?: unknown}): Promise<void> {
    await this.pool.query(`
      INSERT INTO ${this.tables.auditEvents} (id, identity_id, session_id, event_type, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `, [randomUUID(), input.identityId ?? null, input.sessionId ?? null, input.eventType, input.metadata === undefined ? null : JSON.stringify(input.metadata)]);
  }
}
