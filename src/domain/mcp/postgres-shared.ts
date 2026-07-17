import {buildRuntimeRelationNames} from "../../lib/postgres-relations.js";

export interface McpTableNames {
  prefix: string;
  configs: string;
}

export function buildMcpTableNames(): McpTableNames {
  return buildRuntimeRelationNames({configs: "agent_mcp_configs"});
}
