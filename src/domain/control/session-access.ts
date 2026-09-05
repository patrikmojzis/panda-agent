import type {PgQueryable} from "../../lib/postgres-query.js";
import {requireNonEmptyString} from "../../lib/strings.js";
import {buildAgentTableNames} from "../agents/postgres-shared.js";
import {buildSessionTableNames} from "../sessions/postgres-shared.js";
import {buildControlTableNames} from "./postgres-shared.js";
import type {ControlSessionRecord} from "./types.js";

const agents = buildAgentTableNames();
const sessions = buildSessionTableNames();
const control = buildControlTableNames();

/** Checks the current Control grant and pairing before accessing a session. */
export async function assertControlSessionAccess(
  pool: PgQueryable,
  session: Pick<ControlSessionRecord, "identityId" | "role">,
  agentKey: string,
  targetSessionId: string,
  unavailableMessage: string,
): Promise<void> {
  const normalizedAgentKey = requireNonEmptyString(agentKey, "Agent key is required.");
  const normalizedSessionId = requireNonEmptyString(targetSessionId, "Session id is required.");
  const result = await pool.query(`
      SELECT 1
      FROM ${sessions.sessions} AS target_session
      INNER JOIN ${control.grants} AS grant_row
        ON grant_row.identity_id = $1
       AND grant_row.active = TRUE
       AND grant_row.role = $4
       AND (grant_row.role = 'admin' OR grant_row.agent_key = target_session.agent_key)
      LEFT JOIN ${agents.agentPairings} AS pairing
        ON pairing.agent_key = target_session.agent_key
       AND pairing.identity_id = $1
      WHERE target_session.id = $2
        AND target_session.agent_key = $3
        AND (grant_row.role = 'admin' OR pairing.identity_id IS NOT NULL)
      LIMIT 1
    `, [session.identityId, normalizedSessionId, normalizedAgentKey, session.role]);
  if (result.rows.length === 0) {
    throw new Error(unavailableMessage);
  }
}
