import {createHash, randomBytes, randomUUID, timingSafeEqual} from "node:crypto";

import type {Pool} from "pg";

import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildIdentityTableNames} from "../identity/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {
  buildRuntimeRelationNames,
  CREATE_RUNTIME_SCHEMA_SQL,
  quoteIdentifier,
  toMillis,
} from "../threads/runtime/postgres-shared.js";

export const APP_CSRF_COOKIE_PREFIX = "panda_app_csrf_";
export const APP_SESSION_COOKIE_PREFIX = "panda_app_session_";
export const DEFAULT_APP_LAUNCH_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_APP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function buildCookieNameSuffix(agentKey: string, appSlug: string): string {
  return `${agentKey.length}_${agentKey}_${appSlug.length}_${appSlug}`.replace(/[^A-Za-z0-9_-]/g, "_");
}

export function buildAgentAppCookieNames(agentKey: string, appSlug: string): {
  csrf: string;
  session: string;
} {
  const suffix = buildCookieNameSuffix(agentKey, appSlug);
  return {
    csrf: `${APP_CSRF_COOKIE_PREFIX}${suffix}`,
    session: `${APP_SESSION_COOKIE_PREFIX}${suffix}`,
  };
}

interface PgQueryable {
  query: Pool["query"];
}

interface AgentAppAuthTableNames {
  prefix: string;
  launchTokens: string;
  sessions: string;
}

export interface CreateAgentAppLaunchTokenInput {
  agentKey: string;
  appSlug: string;
  identityId: string;
  sessionId?: string;
  expiresInMs?: number;
}

export interface AgentAppLaunchTokenResult {
  token: string;
  expiresAt: number;
}

export interface RedeemedAgentAppSession {
  session: AgentAppSessionRecord;
  sessionToken: string;
  csrfToken: string;
}

export interface AgentAppSessionRecord {
  id: string;
  agentKey: string;
  appSlug: string;
  identityId: string;
  sessionId?: string;
  csrfTokenHash: string;
  expiresAt: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface AgentAppAuthService {
  createLaunchToken(input: CreateAgentAppLaunchTokenInput): Promise<AgentAppLaunchTokenResult>;
  redeemLaunchToken(token: string, options?: {sessionTtlMs?: number}): Promise<RedeemedAgentAppSession>;
  getSessionByToken(token: string): Promise<AgentAppSessionRecord | null>;
  verifyCsrfToken(session: AgentAppSessionRecord, token: string): boolean;
}

function buildAgentAppAuthTableNames(): AgentAppAuthTableNames {
  return buildRuntimeRelationNames({
    launchTokens: "app_launch_tokens",
    sessions: "app_sessions",
  });
}

function generateToken(prefix: string): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function tokenMatches(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "utf8");
  const expected = Buffer.from(expectedHash, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requireTrimmed(label: string, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty.`);
  }

  return trimmed;
}

function positiveDuration(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 1000) {
    throw new Error("Duration must be at least 1 second.");
  }

  return Math.floor(value);
}

function parseSessionRow(row: Record<string, unknown>): AgentAppSessionRecord {
  return {
    id: String(row.id),
    agentKey: String(row.agent_key),
    appSlug: String(row.app_slug),
    identityId: String(row.identity_id),
    sessionId: row.session_id === null || row.session_id === undefined ? undefined : String(row.session_id),
    csrfTokenHash: String(row.csrf_token_hash),
    expiresAt: toMillis(row.expires_at),
    createdAt: toMillis(row.created_at),
    lastSeenAt: toMillis(row.last_seen_at),
  };
}

export class PostgresAgentAppAuthService implements AgentAppAuthService {
  private readonly pool: PgQueryable;
  private readonly tables = buildAgentAppAuthTableNames();
  private readonly agentTables = buildAgentTableNames();
  private readonly identityTables = buildIdentityTableNames();
  private readonly sessionTables = buildSessionTableNames();

  constructor(options: {pool: PgQueryable}) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await this.pool.query(CREATE_RUNTIME_SCHEMA_SQL);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.launchTokens} (
        id TEXT PRIMARY KEY,
        token_hash TEXT NOT NULL UNIQUE,
        agent_key TEXT NOT NULL REFERENCES ${this.agentTables.agents}(agent_key) ON DELETE CASCADE,
        app_slug TEXT NOT NULL,
        identity_id TEXT NOT NULL REFERENCES ${this.identityTables.identities}(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES ${this.sessionTables.sessions}(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_app_launch_tokens_lookup_idx`)}
      ON ${this.tables.launchTokens} (agent_key, app_slug, identity_id, expires_at DESC)
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS ${this.tables.sessions} (
        id TEXT PRIMARY KEY,
        session_token_hash TEXT NOT NULL UNIQUE,
        csrf_token_hash TEXT NOT NULL,
        agent_key TEXT NOT NULL REFERENCES ${this.agentTables.agents}(agent_key) ON DELETE CASCADE,
        app_slug TEXT NOT NULL,
        identity_id TEXT NOT NULL REFERENCES ${this.identityTables.identities}(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES ${this.sessionTables.sessions}(id) ON DELETE SET NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS ${quoteIdentifier(`${this.tables.prefix}_app_sessions_lookup_idx`)}
      ON ${this.tables.sessions} (agent_key, app_slug, identity_id, expires_at DESC)
      WHERE revoked_at IS NULL
    `);
  }

  async createLaunchToken(input: CreateAgentAppLaunchTokenInput): Promise<AgentAppLaunchTokenResult> {
    const token = generateToken("pal");
    const expiresInMs = positiveDuration(input.expiresInMs, DEFAULT_APP_LAUNCH_TOKEN_TTL_MS);
    const expiresAt = Date.now() + expiresInMs;

    await this.pool.query(`
      INSERT INTO ${this.tables.launchTokens} (
        id,
        token_hash,
        agent_key,
        app_slug,
        identity_id,
        session_id,
        expires_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7
      )
    `, [
      randomUUID(),
      hashToken(token),
      requireTrimmed("Agent key", input.agentKey),
      requireTrimmed("App slug", input.appSlug),
      requireTrimmed("Identity id", input.identityId),
      input.sessionId?.trim() || null,
      new Date(expiresAt),
    ]);

    return {
      token,
      expiresAt,
    };
  }

  async redeemLaunchToken(
    token: string,
    options: {sessionTtlMs?: number} = {},
  ): Promise<RedeemedAgentAppSession> {
    const launch = await this.pool.query(`
      UPDATE ${this.tables.launchTokens}
      SET consumed_at = NOW()
      WHERE token_hash = $1
        AND consumed_at IS NULL
        AND expires_at > NOW()
      RETURNING agent_key, app_slug, identity_id, session_id
    `, [hashToken(requireTrimmed("Launch token", token))]);

    const row = launch.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("App launch link is invalid, expired, or already used.");
    }

    const sessionToken = generateToken("pas");
    const csrfToken = generateToken("pac");
    const expiresAt = Date.now() + positiveDuration(options.sessionTtlMs, DEFAULT_APP_SESSION_TTL_MS);
    const session = await this.pool.query(`
      INSERT INTO ${this.tables.sessions} (
        id,
        session_token_hash,
        csrf_token_hash,
        agent_key,
        app_slug,
        identity_id,
        session_id,
        expires_at
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8
      )
      RETURNING *
    `, [
      randomUUID(),
      hashToken(sessionToken),
      hashToken(csrfToken),
      String(row.agent_key),
      String(row.app_slug),
      String(row.identity_id),
      row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
      new Date(expiresAt),
    ]);

    return {
      session: parseSessionRow(session.rows[0] as Record<string, unknown>),
      sessionToken,
      csrfToken,
    };
  }

  async getSessionByToken(token: string): Promise<AgentAppSessionRecord | null> {
    const result = await this.pool.query(`
      UPDATE ${this.tables.sessions}
      SET last_seen_at = NOW()
      WHERE session_token_hash = $1
        AND revoked_at IS NULL
        AND expires_at > NOW()
      RETURNING *
    `, [hashToken(requireTrimmed("App session token", token))]);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseSessionRow(row) : null;
  }

  verifyCsrfToken(session: AgentAppSessionRecord, token: string): boolean {
    return tokenMatches(token, session.csrfTokenHash);
  }
}
