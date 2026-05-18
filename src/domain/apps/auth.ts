import {randomUUID} from "node:crypto";

import {generateOpaqueToken, hashOpaqueToken, opaqueTokenMatches} from "../../lib/opaque-tokens.js";
import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireTimestampMillis} from "../../lib/postgres-values.js";
import {optionalNonEmptyString, requireNonEmptyString} from "../../lib/strings.js";
import {ensurePostgresAgentAppAuthSchema} from "./auth-schema.js";
import {buildAgentAppAuthTableNames} from "./auth-shared.js";

const APP_CSRF_COOKIE_PREFIX = "panda_app_csrf_";
const APP_SESSION_COOKIE_PREFIX = "panda_app_session_";
const DEFAULT_APP_LAUNCH_TOKEN_TTL_MS = 10 * 60 * 1000;
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

function requireAppAuthString(label: string, value: unknown): string {
  return requireNonEmptyString(value, `${label} must not be empty.`);
}

function optionalAppAuthString(label: string, value: unknown): string | undefined {
  return optionalNonEmptyString(value, `${label} must not be empty.`);
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

function parseLaunchRow(row: Record<string, unknown>): {
  agentKey: string;
  appSlug: string;
  identityId: string;
  sessionId?: string;
} {
  return {
    agentKey: requireAppAuthString("App launch agent key", row.agent_key),
    appSlug: requireAppAuthString("App launch slug", row.app_slug),
    identityId: requireAppAuthString("App launch identity id", row.identity_id),
    sessionId: optionalAppAuthString("App launch session id", row.session_id),
  };
}

function parseSessionRow(row: Record<string, unknown>): AgentAppSessionRecord {
  return {
    id: requireAppAuthString("App session id", row.id),
    agentKey: requireAppAuthString("App session agent key", row.agent_key),
    appSlug: requireAppAuthString("App session slug", row.app_slug),
    identityId: requireAppAuthString("App session identity id", row.identity_id),
    sessionId: optionalAppAuthString("App session runtime session id", row.session_id),
    csrfTokenHash: requireAppAuthString("App session CSRF token hash", row.csrf_token_hash),
    expiresAt: requireTimestampMillis(row.expires_at, "App session expires_at must be a valid timestamp."),
    createdAt: requireTimestampMillis(row.created_at, "App session created_at must be a valid timestamp."),
    lastSeenAt: requireTimestampMillis(row.last_seen_at, "App session last_seen_at must be a valid timestamp."),
  };
}

export class PostgresAgentAppAuthService implements AgentAppAuthService {
  private readonly pool: PgQueryable;
  private readonly tables = buildAgentAppAuthTableNames();

  constructor(options: {pool: PgQueryable}) {
    this.pool = options.pool;
  }

  async ensureSchema(): Promise<void> {
    await ensurePostgresAgentAppAuthSchema(this.pool);
  }

  async createLaunchToken(input: CreateAgentAppLaunchTokenInput): Promise<AgentAppLaunchTokenResult> {
    const token = generateOpaqueToken("pal");
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
      hashOpaqueToken(token),
      requireAppAuthString("Agent key", input.agentKey),
      requireAppAuthString("App slug", input.appSlug),
      requireAppAuthString("Identity id", input.identityId),
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
    `, [hashOpaqueToken(requireAppAuthString("Launch token", token))]);

    const row = launch.rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("App launch link is invalid, expired, or already used.");
    }
    const launchRow = parseLaunchRow(row);

    const sessionToken = generateOpaqueToken("pas");
    const csrfToken = generateOpaqueToken("pac");
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
      hashOpaqueToken(sessionToken),
      hashOpaqueToken(csrfToken),
      launchRow.agentKey,
      launchRow.appSlug,
      launchRow.identityId,
      launchRow.sessionId ?? null,
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
    `, [hashOpaqueToken(requireAppAuthString("App session token", token))]);

    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? parseSessionRow(row) : null;
  }

  verifyCsrfToken(session: AgentAppSessionRecord, token: string): boolean {
    return opaqueTokenMatches(token, session.csrfTokenHash);
  }
}
