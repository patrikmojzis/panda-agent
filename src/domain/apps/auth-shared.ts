import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

interface AgentAppAuthTableNames {
  prefix: string;
  launchTokens: string;
  sessions: string;
}

export function buildAgentAppAuthTableNames(): AgentAppAuthTableNames {
  return buildRuntimeRelationNames({
    launchTokens: "app_launch_tokens",
    sessions: "app_sessions",
  });
}
