import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildCredentialTableNames} from "../credentials/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

export interface ControlAgentSummary {
  agentKey: string;
  displayName: string;
  status: string;
  sessionCount: number;
  paired: boolean;
}

export interface ControlCredentialSummary {
  agentKey: string;
  envKey: string;
  present: true;
  createdAt: string;
  updatedAt: string;
}

export interface ControlAuditEventSummary {
  id: string;
  identityId?: string;
  sessionId?: string;
  eventType: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface ListAuditEventsInput {
  limit?: number;
  eventType?: string;
  before?: string;
}

const CONTROL_AUDIT_DEFAULT_LIMIT = 50;
const CONTROL_AUDIT_MAX_LIMIT = 100;

function auditLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return CONTROL_AUDIT_DEFAULT_LIMIT;
  return Math.max(1, Math.min(CONTROL_AUDIT_MAX_LIMIT, Math.trunc(value)));
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed);
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeContentSummary(value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  return {
    ...(typeof raw.wasSet === "boolean" ? {wasSet: raw.wasSet} : {}),
    ...(typeof raw.length === "number" ? {length: raw.length} : {}),
    ...(typeof raw.sha256 === "string" || raw.sha256 === null ? {sha256: raw.sha256} : {}),
  };
}

function safeHeartbeatSummary(value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  return {
    ...(typeof raw.enabled === "boolean" ? {enabled: raw.enabled} : {}),
    ...(typeof raw.everyMinutes === "number" ? {everyMinutes: raw.everyMinutes} : {}),
    ...(typeof raw.nextFireAt === "string" ? {nextFireAt: raw.nextFireAt} : {}),
    ...(typeof raw.lastFireAt === "string" ? {lastFireAt: raw.lastFireAt} : {}),
  };
}

function sanitizedAuditMetadata(eventType: string, value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  if (eventType === "session_briefing_write") {
    return {
      ...(raw.action === "put" || raw.action === "delete" ? {action: raw.action} : {}),
      ...(typeof raw.agentKey === "string" ? {agentKey: raw.agentKey} : {}),
      ...(typeof raw.targetSessionId === "string" ? {targetSessionId: raw.targetSessionId} : {}),
      ...(typeof raw.slug === "string" ? {slug: raw.slug} : {}),
      old: safeContentSummary(raw.old),
      next: safeContentSummary(raw.next),
    };
  }
  if (eventType === "session_heartbeat_config_write") {
    return {
      ...(raw.action === "patch" ? {action: raw.action} : {}),
      ...(typeof raw.agentKey === "string" ? {agentKey: raw.agentKey} : {}),
      ...(typeof raw.targetSessionId === "string" ? {targetSessionId: raw.targetSessionId} : {}),
      old: safeHeartbeatSummary(raw.old),
      next: safeHeartbeatSummary(raw.next),
    };
  }
  return {};
}

export class ControlReadService {
  private readonly pool: PgQueryable;
  private readonly agents = buildAgentTableNames();
  private readonly sessions = buildSessionTableNames();
  private readonly threads = buildThreadRuntimeTableNames();
  private readonly credentials = buildCredentialTableNames();
  private readonly control = buildControlTableNames();

  constructor(options: {pool: PgQueryable}) {
    this.pool = options.pool;
  }

  async listAgents(session: ControlSessionRecord): Promise<readonly ControlAgentSummary[]> {
    const result = session.role === "admin"
      ? await this.pool.query(`
        SELECT agent.agent_key, agent.display_name, agent.status,
          COUNT(agent_session.id)::int AS session_count,
          COUNT(pairing.identity_id)::int AS pairing_count
        FROM ${this.agents.agents} AS agent
        LEFT JOIN ${this.sessions.sessions} AS agent_session ON agent_session.agent_key = agent.agent_key
        LEFT JOIN ${this.agents.agentPairings} AS pairing
          ON pairing.agent_key = agent.agent_key AND pairing.identity_id = $1
        WHERE agent.status = 'active'
        GROUP BY agent.agent_key, agent.display_name, agent.status
        ORDER BY agent.agent_key ASC
      `, [session.identityId])
      : await this.pool.query(`
        SELECT agent.agent_key, agent.display_name, agent.status,
          COUNT(agent_session.id)::int AS session_count,
          COUNT(pairing.identity_id)::int AS pairing_count
        FROM ${this.agents.agents} AS agent
        INNER JOIN ${this.control.grants} AS grant_row
          ON grant_row.agent_key = agent.agent_key
         AND grant_row.identity_id = $1
         AND grant_row.role = 'scoped'
         AND grant_row.active = TRUE
        INNER JOIN ${this.agents.agentPairings} AS pairing
          ON pairing.agent_key = agent.agent_key AND pairing.identity_id = grant_row.identity_id
        LEFT JOIN ${this.sessions.sessions} AS agent_session ON agent_session.agent_key = agent.agent_key
        WHERE agent.status = 'active'
        GROUP BY agent.agent_key, agent.display_name, agent.status
        ORDER BY agent.agent_key ASC
      `, [session.identityId]);

    return result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        agentKey: String(row.agent_key),
        displayName: String(row.display_name),
        status: String(row.status),
        sessionCount: Number(row.session_count ?? 0),
        paired: Number(row.pairing_count ?? 0) > 0,
      };
    });
  }

  async getOverview(session: ControlSessionRecord): Promise<Record<string, unknown>> {
    const agents = await this.listAgents(session);
    const agentKeys = agents.map((agent) => agent.agentKey);
    const values: unknown[] = session.role === "admin" ? [] : [agentKeys];
    const agentFilter = session.role === "admin" ? "TRUE" : "agent_key = ANY($1::text[])";
    const runningRunsFilter = session.role === "admin" ? "TRUE" : "agent_session.agent_key = ANY($1::text[])";
    const [sessions, runningRuns, credentials] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::int AS count FROM ${this.sessions.sessions} WHERE ${agentFilter}`, values),
      this.pool.query(`
        SELECT COUNT(*)::int AS count
        FROM ${this.threads.runs} AS run
        INNER JOIN ${this.threads.threads} AS thread ON thread.id = run.thread_id
        INNER JOIN ${this.sessions.sessions} AS agent_session ON agent_session.id = thread.session_id
        WHERE run.status = 'running' AND ${runningRunsFilter}
      `, values),
      this.pool.query(`SELECT COUNT(*)::int AS count FROM ${this.credentials.credentials} WHERE ${agentFilter}`, values),
    ]);
    return {
      agents: agents.length,
      sessions: Number((sessions.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
      runningRuns: Number((runningRuns.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
      credentialsPresent: Number((credentials.rows[0] as Record<string, unknown> | undefined)?.count ?? 0),
    };
  }

  async listAuditEvents(session: ControlSessionRecord, input: ListAuditEventsInput = {}): Promise<readonly ControlAuditEventSummary[]> {
    const limit = auditLimit(input.limit);
    const values: unknown[] = [];
    const where: string[] = [];
    if (input.eventType) {
      values.push(input.eventType);
      where.push(`event_type = $${values.length}`);
    }
    if (input.before) {
      values.push(new Date(input.before));
      where.push(`created_at < $${values.length}`);
    }

    if (session.role === "scoped") {
      const visibleAgentKeys = (await this.listAgents(session)).map((agent) => agent.agentKey);
      values.push(session.identityId);
      const identityParam = `$${values.length}`;
      values.push(visibleAgentKeys);
      const agentsParam = `$${values.length}`;
      where.push(`identity_id = ${identityParam}`);
      where.push(`((event_type IN ('login', 'logout')) OR (event_type IN ('session_briefing_write', 'session_heartbeat_config_write') AND metadata->>'agentKey' = ANY(${agentsParam}::text[])))`);
    }

    values.push(limit);
    const result = await this.pool.query(`
      SELECT id, identity_id, session_id, event_type, metadata, created_at
      FROM ${this.control.auditEvents}
      WHERE ${where.length > 0 ? where.join(" AND ") : "TRUE"}
      ORDER BY created_at DESC, id DESC
      LIMIT $${values.length}
    `, values);

    return result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id),
        ...(typeof row.identity_id === "string" ? {identityId: row.identity_id} : {}),
        ...(typeof row.session_id === "string" ? {sessionId: row.session_id} : {}),
        eventType: String(row.event_type),
        metadata: sanitizedAuditMetadata(String(row.event_type), row.metadata),
        createdAt: new Date(row.created_at as Date).toISOString(),
      };
    });
  }

  async listCredentials(session: ControlSessionRecord): Promise<readonly ControlCredentialSummary[]> {
    const agents = await this.listAgents(session);
    const values: unknown[] = session.role === "admin" ? [] : [agents.map((agent) => agent.agentKey)];
    const result = await this.pool.query(`
      SELECT agent_key, env_key, created_at, updated_at
      FROM ${this.credentials.credentials}
      WHERE ${session.role === "admin" ? "TRUE" : "agent_key = ANY($1::text[])"}
      ORDER BY agent_key ASC, env_key ASC
    `, values);

    return result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        agentKey: String(row.agent_key),
        envKey: String(row.env_key),
        present: true,
        createdAt: new Date(row.created_at as Date).toISOString(),
        updatedAt: new Date(row.updated_at as Date).toISOString(),
      };
    });
  }
}
