import type {
    AgentDiaryRecord,
    AgentDocumentRecord,
    AgentDocumentSlug,
    AgentPairingRecord,
    AgentPromptRecord,
    AgentPromptSlug,
    AgentRecord,
    AgentSkillRecord,
    BootstrapAgentInput,
} from "./types.js";

export interface AgentStore {
  ensureSchema(): Promise<void>;
  bootstrapAgent(input: BootstrapAgentInput): Promise<AgentRecord>;
  getAgent(agentKey: string): Promise<AgentRecord>;
  listAgents(): Promise<readonly AgentRecord[]>;
  ensurePairing(agentKey: string, identityId: string): Promise<AgentPairingRecord>;
  deletePairing(agentKey: string, identityId: string): Promise<boolean>;
  listAgentPairings(agentKey: string): Promise<readonly AgentPairingRecord[]>;
  listIdentityPairings(identityId: string): Promise<readonly AgentPairingRecord[]>;
  listAgentSkills(agentKey: string): Promise<readonly AgentSkillRecord[]>;
  readAgentSkill(agentKey: string, skillKey: string): Promise<AgentSkillRecord | null>;
  loadAgentSkill(agentKey: string, skillKey: string): Promise<AgentSkillRecord | null>;
  setAgentSkill(agentKey: string, skillKey: string, description: string, content: string): Promise<AgentSkillRecord>;
  deleteAgentSkill(agentKey: string, skillKey: string): Promise<boolean>;
  readAgentPrompt(agentKey: string, slug: AgentPromptSlug): Promise<AgentPromptRecord | null>;
  setAgentPrompt(agentKey: string, slug: AgentPromptSlug, content: string): Promise<AgentPromptRecord>;
  transformAgentPrompt(agentKey: string, slug: AgentPromptSlug, expression: string): Promise<AgentPromptRecord>;
  readAgentDocument(
    agentKey: string,
    slug: AgentDocumentSlug,
    identityId?: string,
  ): Promise<AgentDocumentRecord | null>;
  setAgentDocument(
    agentKey: string,
    slug: AgentDocumentSlug,
    content: string,
    identityId?: string,
  ): Promise<AgentDocumentRecord>;
  transformAgentDocument(
    agentKey: string,
    slug: AgentDocumentSlug,
    expression: string,
    identityId?: string,
  ): Promise<AgentDocumentRecord>;
  readDiaryEntry(agentKey: string, entryDate: string, identityId?: string): Promise<AgentDiaryRecord | null>;
  setDiaryEntry(agentKey: string, entryDate: string, content: string, identityId?: string): Promise<AgentDiaryRecord>;
  transformDiaryEntry(agentKey: string, entryDate: string, expression: string, identityId?: string): Promise<AgentDiaryRecord>;
  listDiaryEntries(agentKey: string, limit?: number, identityId?: string): Promise<readonly AgentDiaryRecord[]>;
}
