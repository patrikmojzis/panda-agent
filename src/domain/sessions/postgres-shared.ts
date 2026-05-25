import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface SessionTableNames {
  prefix: string;
  sessions: string;
  sessionHeartbeats: string;
  sessionPrompts: string;
  sessionTodos: string;
  sessionRuntimeConfig: string;
}

export function buildSessionTableNames(): SessionTableNames {
  return buildRuntimeRelationNames({
    sessions: "agent_sessions",
    sessionHeartbeats: "session_heartbeats",
    sessionPrompts: "session_prompts",
    sessionTodos: "session_todos",
    sessionRuntimeConfig: "session_runtime_config",
  });
}
