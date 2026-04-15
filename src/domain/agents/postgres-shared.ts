import {buildPrefixedRelationNames} from "../../domain/threads/runtime/postgres-shared.js";

export interface AgentTableNames {
  prefix: string;
  agents: string;
  agentSkills: string;
  agentPrompts: string;
  agentDocuments: string;
  agentPairings: string;
  agentDiary: string;
}

export function buildAgentTableNames(prefix: string): AgentTableNames {
  return buildPrefixedRelationNames(prefix, {
    agents: "agents",
    agentSkills: "agent_skills",
    agentPrompts: "agent_prompts",
    agentDocuments: "agent_documents",
    agentPairings: "agent_pairings",
    agentDiary: "agent_diary",
  });
}
