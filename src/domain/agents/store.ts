import type {
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
}
