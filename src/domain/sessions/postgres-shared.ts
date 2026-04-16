import {buildRuntimeRelationNames} from "../threads/runtime/postgres-shared.js";

export interface SessionTableNames {
  prefix: string;
  sessions: string;
  sessionHeartbeats: string;
}

export function buildSessionTableNames(): SessionTableNames {
  return buildRuntimeRelationNames({
    sessions: "agent_sessions",
    sessionHeartbeats: "session_heartbeats",
  });
}
