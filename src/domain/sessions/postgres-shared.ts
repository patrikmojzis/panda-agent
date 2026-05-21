import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface SessionTableNames {
  prefix: string;
  sessions: string;
  sessionHeartbeats: string;
  sessionPrompts: string;
}

export function buildSessionTableNames(): SessionTableNames {
  return buildRuntimeRelationNames({
    sessions: "agent_sessions",
    sessionHeartbeats: "session_heartbeats",
    sessionPrompts: "session_prompts",
  });
}
