import {buildPrefixedRelationNames} from "../../domain/threads/runtime/postgres-shared.js";

export interface AgentTableNames {
  prefix: string;
  agents: string;
  agentSkills: string;
  agentDocuments: string;
  relationshipDocuments: string;
  agentDiary: string;
}

export function buildAgentTableNames(prefix: string): AgentTableNames {
  return buildPrefixedRelationNames(prefix, {
    agents: "agents",
    agentSkills: "agent_skills",
    agentDocuments: "agent_documents",
    relationshipDocuments: "relationship_documents",
    agentDiary: "agent_diary",
  });
}
