import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import type {SessionStore} from "../sessions/store.js";
import type {SessionHeartbeatRecord} from "../sessions/types.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

export const CONTROL_HEARTBEAT_MIN_EVERY_MINUTES = 15;
export const CONTROL_HEARTBEAT_CONFIRM = "update-heartbeat";

export interface ControlHeartbeatRecord {
  agentKey: string;
  sessionId: string;
  enabled: boolean;
  everyMinutes: number;
  nextFireAt: string;
  lastFireAt?: string;
}

export interface ControlHeartbeatPatchInput {
  enabled?: boolean;
  everyMinutes?: number;
  confirm?: string;
}

export interface ControlHeartbeatMutationAudit {
  action: "patch";
  agentKey: string;
  targetSessionId: string;
  old: ControlHeartbeatMetadata;
  next: ControlHeartbeatMetadata;
}

interface ControlHeartbeatMetadata {
  enabled: boolean;
  everyMinutes: number;
  nextFireAt: string;
  lastFireAt?: string;
}

function publicHeartbeat(agentKey: string, heartbeat: SessionHeartbeatRecord): ControlHeartbeatRecord {
  return {
    agentKey,
    sessionId: heartbeat.sessionId,
    enabled: heartbeat.enabled,
    everyMinutes: heartbeat.everyMinutes,
    nextFireAt: new Date(heartbeat.nextFireAt).toISOString(),
    ...(heartbeat.lastFireAt !== undefined ? {lastFireAt: new Date(heartbeat.lastFireAt).toISOString()} : {}),
  };
}

function auditHeartbeat(heartbeat: SessionHeartbeatRecord): ControlHeartbeatMetadata {
  return {
    enabled: heartbeat.enabled,
    everyMinutes: heartbeat.everyMinutes,
    nextFireAt: new Date(heartbeat.nextFireAt).toISOString(),
    ...(heartbeat.lastFireAt !== undefined ? {lastFireAt: new Date(heartbeat.lastFireAt).toISOString()} : {}),
  };
}

function requireControlCadence(value: number): number {
  if (!Number.isInteger(value) || value < CONTROL_HEARTBEAT_MIN_EVERY_MINUTES) {
    throw new Error(`Control heartbeat cadence must be an integer of at least ${CONTROL_HEARTBEAT_MIN_EVERY_MINUTES} minutes.`);
  }
  return value;
}

export class ControlHeartbeatService {
  private readonly pool: PgQueryable;
  private readonly sessions: Pick<SessionStore, "getHeartbeat" | "updateHeartbeatConfig">;
  private readonly agents = buildAgentTableNames();
  private readonly sessionTables = buildSessionTableNames();
  private readonly control = buildControlTableNames();

  constructor(options: {pool: PgQueryable; sessions: Pick<SessionStore, "getHeartbeat" | "updateHeartbeatConfig">}) {
    this.pool = options.pool;
    this.sessions = options.sessions;
  }

  private async assertCanAccess(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<void> {
    const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
    const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
    const result = await this.pool.query(`
      SELECT 1
      FROM ${this.sessionTables.sessions} AS target_session
      INNER JOIN ${this.agents.agentPairings} AS pairing
        ON pairing.agent_key = target_session.agent_key
       AND pairing.identity_id = $1
      INNER JOIN ${this.control.grants} AS grant_row
        ON grant_row.identity_id = $1
       AND grant_row.active = TRUE
       AND (grant_row.role = 'admin' OR (grant_row.role = 'scoped' AND grant_row.agent_key = target_session.agent_key))
      WHERE target_session.id = $2
        AND target_session.agent_key = $3
      LIMIT 1
    `, [session.identityId, normalizedSessionId, normalizedAgentKey]);
    if (result.rows.length === 0) {
      throw new Error("Control heartbeat target session was not found or is not visible.");
    }
  }

  async getHeartbeat(session: ControlSessionRecord, agentKey: string, targetSessionId: string): Promise<ControlHeartbeatRecord> {
    await this.assertCanAccess(session, agentKey, targetSessionId);
    const heartbeat = await this.sessions.getHeartbeat(targetSessionId);
    if (!heartbeat) throw new Error("Control heartbeat target session was not found or is not visible.");
    return publicHeartbeat(agentKey, heartbeat);
  }

  async updateHeartbeat(session: ControlSessionRecord, agentKey: string, targetSessionId: string, input: ControlHeartbeatPatchInput): Promise<{heartbeat: ControlHeartbeatRecord; audit: ControlHeartbeatMutationAudit}> {
    if (input.enabled === undefined && input.everyMinutes === undefined) {
      throw new Error("PATCH requires enabled or everyMinutes.");
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new Error("Control heartbeat enabled must be a boolean.");
    }
    if (input.everyMinutes !== undefined) requireControlCadence(input.everyMinutes);

    await this.assertCanAccess(session, agentKey, targetSessionId);
    const oldHeartbeat = await this.sessions.getHeartbeat(targetSessionId);
    if (!oldHeartbeat) throw new Error("Control heartbeat target session was not found or is not visible.");

    const nextEnabled = input.enabled ?? oldHeartbeat.enabled;
    const nextEveryMinutes = input.everyMinutes ?? oldHeartbeat.everyMinutes;
    if (nextEnabled) requireControlCadence(nextEveryMinutes);
    const requiresConfirmation = nextEnabled !== oldHeartbeat.enabled || nextEveryMinutes < oldHeartbeat.everyMinutes;
    if (requiresConfirmation && input.confirm !== CONTROL_HEARTBEAT_CONFIRM) {
      throw new Error(`Heartbeat changes that enable, disable, or reduce cadence require confirm: "${CONTROL_HEARTBEAT_CONFIRM}".`);
    }

    const updated = await this.sessions.updateHeartbeatConfig({
      sessionId: targetSessionId,
      ...(input.enabled !== undefined ? {enabled: input.enabled} : {}),
      ...(input.everyMinutes !== undefined ? {everyMinutes: input.everyMinutes} : {}),
      asOf: new Date().getTime(),
    });
    return {
      heartbeat: publicHeartbeat(agentKey, updated),
      audit: {
        action: "patch",
        agentKey,
        targetSessionId,
        old: auditHeartbeat(oldHeartbeat),
        next: auditHeartbeat(updated),
      },
    };
  }
}
