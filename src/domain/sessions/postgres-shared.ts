import {buildPrefixedRelationNames} from "../threads/runtime/postgres-shared.js";

export interface SessionTableNames {
  prefix: string;
  sessions: string;
  sessionHeartbeats: string;
}

export function buildSessionTableNames(prefix: string): SessionTableNames {
  return buildPrefixedRelationNames(prefix, {
    sessions: "agent_sessions",
    sessionHeartbeats: "session_heartbeats",
  });
}
