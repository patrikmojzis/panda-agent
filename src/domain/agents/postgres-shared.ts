import {buildRuntimeRelationNames} from "../../domain/threads/runtime/postgres-shared.js";

export interface AgentTableNames {
  prefix: string;
  agents: string;
  agentSkills: string;
  agentPrompts: string;
  agentPairings: string;
}

export function buildAgentTableNames(): AgentTableNames {
  return buildRuntimeRelationNames({
    agents: "agents",
    agentSkills: "agent_skills",
    agentPrompts: "agent_prompts",
    agentPairings: "agent_pairings",
  });
}
