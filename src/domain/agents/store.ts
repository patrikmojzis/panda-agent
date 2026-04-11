import type {
    AgentDiaryRecord,
    AgentDocumentRecord,
    AgentDocumentSlug,
    AgentRecord,
    AgentSkillRecord,
    BootstrapAgentInput,
    RelationshipDocumentRecord,
    RelationshipDocumentSlug,
} from "./types.js";

export interface AgentStore {
  ensureSchema(): Promise<void>;
  bootstrapAgent(input: BootstrapAgentInput): Promise<AgentRecord>;
  getAgent(agentKey: string): Promise<AgentRecord>;
  listAgents(): Promise<readonly AgentRecord[]>;
  listAgentSkills(agentKey: string): Promise<readonly AgentSkillRecord[]>;
  readAgentSkill(agentKey: string, skillKey: string): Promise<AgentSkillRecord | null>;
  setAgentSkill(agentKey: string, skillKey: string, description: string, content: string): Promise<AgentSkillRecord>;
  deleteAgentSkill(agentKey: string, skillKey: string): Promise<boolean>;
  readAgentDocument(agentKey: string, slug: AgentDocumentSlug): Promise<AgentDocumentRecord | null>;
  setAgentDocument(agentKey: string, slug: AgentDocumentSlug, content: string): Promise<AgentDocumentRecord>;
  transformAgentDocument(agentKey: string, slug: AgentDocumentSlug, expression: string): Promise<AgentDocumentRecord>;
  readRelationshipDocument(
    agentKey: string,
    identityId: string,
    slug: RelationshipDocumentSlug,
  ): Promise<RelationshipDocumentRecord | null>;
  setRelationshipDocument(
    agentKey: string,
    identityId: string,
    slug: RelationshipDocumentSlug,
    content: string,
  ): Promise<RelationshipDocumentRecord>;
  transformRelationshipDocument(
    agentKey: string,
    identityId: string,
    slug: RelationshipDocumentSlug,
    expression: string,
  ): Promise<RelationshipDocumentRecord>;
  readDiaryEntry(agentKey: string, identityId: string, entryDate: string): Promise<AgentDiaryRecord | null>;
  setDiaryEntry(agentKey: string, identityId: string, entryDate: string, content: string): Promise<AgentDiaryRecord>;
  transformDiaryEntry(agentKey: string, identityId: string, entryDate: string, expression: string): Promise<AgentDiaryRecord>;
  listDiaryEntries(agentKey: string, identityId: string, limit?: number): Promise<readonly AgentDiaryRecord[]>;
}
