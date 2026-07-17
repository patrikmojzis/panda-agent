import type {PgQueryable} from "../../lib/postgres-query.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildCredentialTableNames} from "../credentials/postgres-shared.js";
import {normalizeMcpConfig} from "../mcp/config.js";
import {buildMcpTableNames} from "../mcp/postgres-shared.js";
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
  mcpServerCount: number;
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
  agentKey?: string;
  targetSessionId?: string;
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

function safeHashSummary(value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  return {
    ...(typeof raw.length === "number" ? {length: raw.length} : {}),
    ...(typeof raw.sha256 === "string" ? {sha256: raw.sha256} : {}),
  };
}

function safeScheduleSummary(value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  if (raw.kind === "once") {
    return {
      kind: "once",
      ...(typeof raw.runAt === "string" ? {runAt: raw.runAt} : {}),
    };
  }
  if (raw.kind === "recurring") {
    return {
      kind: "recurring",
      ...(typeof raw.cron === "string" ? {cron: raw.cron} : {}),
      ...(typeof raw.timezone === "string" ? {timezone: raw.timezone} : {}),
    };
  }
  return {};
}

function safeOperatorSummary(value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  const secret = asRecord(raw.secret);
  return {
    ...(typeof raw.action === "string" ? {action: raw.action} : {}),
    ...(typeof raw.agentKey === "string" ? {agentKey: raw.agentKey} : {}),
    ...(typeof raw.targetSessionId === "string" ? {targetSessionId: raw.targetSessionId} : {}),
    ...(typeof raw.sessionId === "string" ? {sessionId: raw.sessionId} : {}),
    ...(typeof raw.recipientAgentKey === "string" ? {recipientAgentKey: raw.recipientAgentKey} : {}),
    ...(typeof raw.recipientSessionId === "string" ? {recipientSessionId: raw.recipientSessionId} : {}),
    ...(typeof raw.peerAgentKey === "string" ? {peerAgentKey: raw.peerAgentKey} : {}),
    ...(typeof raw.peerSessionId === "string" ? {peerSessionId: raw.peerSessionId} : {}),
    ...(raw.direction === "inbound" || raw.direction === "outbound" ? {direction: raw.direction} : {}),
    ...(typeof raw.oneWay === "boolean" ? {oneWay: raw.oneWay} : {}),
    ...(typeof raw.source === "string" ? {source: raw.source} : {}),
    ...(typeof raw.accountKey === "string" ? {accountKey: raw.accountKey} : {}),
    ...(typeof raw.connectorKey === "string" ? {connectorKey: raw.connectorKey} : {}),
    ...(typeof raw.externalConversationId === "string" ? {externalConversationId: raw.externalConversationId} : {}),
    ...(typeof raw.grantId === "string" ? {grantId: raw.grantId} : {}),
    ...(typeof raw.identityHandle === "string" ? {identityHandle: raw.identityHandle} : {}),
    ...(raw.role === "admin" || raw.role === "scoped" ? {role: raw.role} : {}),
    ...(typeof raw.displayName === "string" ? {displayName: raw.displayName} : {}),
    ...(typeof raw.label === "string" ? {label: raw.label} : {}),
    ...(raw.status === "active" || raw.status === "deleted" ? {status: raw.status} : {}),
    ...(typeof raw.loginTokenExpiresAt === "string" ? {loginTokenExpiresAt: raw.loginTokenExpiresAt} : {}),
    ...(typeof raw.envKey === "string" ? {envKey: raw.envKey} : {}),
    ...(typeof raw.serverName === "string" ? {serverName: raw.serverName} : {}),
    ...(raw.transport === "stdio" || raw.transport === "streamable-http" || raw.transport === "sse" ? {transport: raw.transport} : {}),
    ...(typeof raw.enabled === "boolean" ? {enabled: raw.enabled} : {}),
    ...(Array.isArray(raw.changedFields) && raw.changedFields.every((entry) => typeof entry === "string") ? {changedFields: raw.changedFields} : {}),
    ...(Array.isArray(raw.credentialEnvKeys) && raw.credentialEnvKeys.every((entry) => typeof entry === "string") ? {credentialEnvKeys: raw.credentialEnvKeys} : {}),
    ...(typeof raw.skillKey === "string" ? {skillKey: raw.skillKey} : {}),
    ...(typeof raw.agentEditable === "boolean" ? {agentEditable: raw.agentEditable} : {}),
    ...(typeof raw.slug === "string" ? {slug: raw.slug} : {}),
    ...(typeof raw.sourceId === "string" ? {sourceId: raw.sourceId} : {}),
    ...(typeof raw.deviceId === "string" ? {deviceId: raw.deviceId} : {}),
    ...(typeof raw.type === "string" ? {type: raw.type} : {}),
    ...(typeof raw.delivery === "string" ? {delivery: raw.delivery} : {}),
    ...(typeof raw.existed === "boolean" ? {existed: raw.existed} : {}),
    ...(typeof raw.deleted === "boolean" ? {deleted: raw.deleted} : {}),
    ...(typeof raw.wikiGroupId === "number" ? {wikiGroupId: raw.wikiGroupId} : {}),
    ...(typeof raw.namespacePath === "string" ? {namespacePath: raw.namespacePath} : {}),
    ...(typeof secret.length === "number" || typeof secret.sha256 === "string" ? {secret: {
      ...(typeof secret.length === "number" ? {length: secret.length} : {}),
      ...(typeof secret.sha256 === "string" ? {sha256: secret.sha256} : {}),
    }} : {}),
  };
}

function sanitizedAuditMetadata(eventType: string, value: unknown): Record<string, unknown> {
  const raw = asRecord(value);
  if (eventType === "session_briefing_write" || eventType === "session_prompt_write") {
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
  if (eventType === "session_scheduled_task_write") {
    return {
      ...(raw.action === "create_scheduled_task" || raw.action === "update_scheduled_task" || raw.action === "cancel_scheduled_task" ? {action: raw.action} : {}),
      ...(typeof raw.agentKey === "string" ? {agentKey: raw.agentKey} : {}),
      ...(typeof raw.targetSessionId === "string" ? {targetSessionId: raw.targetSessionId} : {}),
      ...(typeof raw.taskId === "string" ? {taskId: raw.taskId} : {}),
      ...(typeof raw.title === "string" ? {title: raw.title} : {}),
      ...(typeof raw.enabled === "boolean" ? {enabled: raw.enabled} : {}),
      schedule: safeScheduleSummary(raw.schedule),
      instruction: safeHashSummary(raw.instruction),
      reason: safeHashSummary(raw.reason),
    };
  }
  if (eventType === "session_watch_config_write") {
    const reason = asRecord(raw.reason);
    return {
      ...(raw.action === "update_watch" || raw.action === "disable_watch" ? {action: raw.action} : {}),
      ...(typeof raw.agentKey === "string" ? {agentKey: raw.agentKey} : {}),
      ...(typeof raw.targetSessionId === "string" ? {targetSessionId: raw.targetSessionId} : {}),
      ...(typeof raw.watchId === "string" ? {watchId: raw.watchId} : {}),
      ...(typeof raw.title === "string" ? {title: raw.title} : {}),
      ...(typeof raw.intervalMinutes === "number" ? {intervalMinutes: raw.intervalMinutes} : {}),
      ...(typeof raw.enabled === "boolean" ? {enabled: raw.enabled} : {}),
      ...(typeof reason.length === "number" ? {reason: {length: reason.length}} : {}),
    };
  }
  if (eventType === "control_operator_write") {
    return safeOperatorSummary(raw);
  }
  if (eventType === "control_dev_login") {
    return {
      ...(raw.role === "admin" || raw.role === "scoped" ? {role: raw.role} : {}),
      ...(typeof raw.identityHandle === "string" ? {identityHandle: raw.identityHandle} : {}),
      ...(typeof raw.agentKey === "string" ? {agentKey: raw.agentKey} : {}),
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
  private readonly mcp = buildMcpTableNames();

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

    const summaries = result.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        agentKey: String(row.agent_key),
        displayName: String(row.display_name),
        status: String(row.status),
        sessionCount: Number(row.session_count ?? 0),
        paired: Number(row.pairing_count ?? 0) > 0,
        mcpServerCount: 0,
      };
    });
    if (summaries.length === 0) return summaries;
    const configs = await this.pool.query(`
      SELECT agent_key, config
      FROM ${this.mcp.configs}
      WHERE agent_key IN (${summaries.map((_, index) => `$${index + 1}`).join(", ")})
    `, summaries.map((agent) => agent.agentKey));
    const counts = new Map(configs.rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return [String(row.agent_key), Object.keys(normalizeMcpConfig(row.config).servers).length] as const;
    }));
    return summaries.map((agent) => ({...agent, mcpServerCount: counts.get(agent.agentKey) ?? 0}));
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
    if (input.agentKey) {
      values.push(input.agentKey);
      where.push(`metadata->>'agentKey' = $${values.length}`);
    }
    if (input.targetSessionId) {
      values.push(input.targetSessionId);
      where.push(`(metadata->>'targetSessionId' = $${values.length} OR metadata->>'sessionId' = $${values.length})`);
    }

    if (session.role === "scoped") {
      const visibleAgentKeys = (await this.listAgents(session)).map((agent) => agent.agentKey);
      values.push(session.identityId);
      const identityParam = `$${values.length}`;
      values.push(visibleAgentKeys);
      const agentsParam = `$${values.length}`;
      where.push(`identity_id = ${identityParam}`);
      where.push(`((event_type IN ('login', 'logout', 'control_dev_login')) OR (event_type IN ('session_briefing_write', 'session_prompt_write', 'session_heartbeat_config_write', 'session_scheduled_task_write', 'session_watch_config_write', 'control_operator_write') AND metadata->>'agentKey' = ANY(${agentsParam}::text[])))`);
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
