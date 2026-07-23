import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface McpTableNames {
  prefix: string;
  configs: string;
  oauthConnections: string;
  oauthAttempts: string;
}

export function buildMcpTableNames(): McpTableNames {
  return buildRuntimeRelationNames({
    configs: "agent_mcp_configs",
    oauthConnections: "agent_mcp_oauth_connections",
    oauthAttempts: "agent_mcp_oauth_attempts",
  });
}
