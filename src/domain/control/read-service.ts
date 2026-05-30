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
    const [sessions, runningRuns, credentials] = await Promise.all([
      this.pool.query(`SELECT COUNT(*)::int AS count FROM ${this.sessions.sessions} WHERE ${agentFilter}`, values),
      this.pool.query(`
        SELECT COUNT(*)::int AS count
        FROM ${this.threads.runs} AS run
        INNER JOIN ${this.threads.threads} AS thread ON thread.id = run.thread_id
        WHERE run.status = 'running' AND ${session.role === "admin" ? "TRUE" : "thread.agent_key = ANY($1::text[])"}
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
