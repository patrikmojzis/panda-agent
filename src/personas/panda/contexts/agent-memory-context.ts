import {LlmContext} from "../../../kernel/agent/llm-context.js";
import {
    type AgentWorkspaceDiaryEntry,
    type AgentWorkspaceDocSection,
    type AgentWorkspaceSkillEntry,
    renderAgentWorkspaceContext,
} from "../../../prompts/contexts/agent-workspace.js";
import type {AgentStore} from "../../../domain/agents/store.js";

// Heartbeat guidance should only show up on heartbeat wakes, not in every normal run.
const AGENT_DOC_SLUGS = ["agent", "soul", "playbook"] as const;
const AGENT_DOCUMENT_SLUG = "memory" as const;

export type AgentMemoryContextSection =
  | "agent_docs"
  | "relationship_memory"
  | "diary"
  | "skills";

export interface AgentMemoryContextOptions {
  store: AgentStore;
  agentKey: string;
  identityId?: string;
  sections?: readonly AgentMemoryContextSection[];
}

export class AgentMemoryContext extends LlmContext {
  override name = "Agent Workspace";

  private readonly options: AgentMemoryContextOptions;

  constructor(options: AgentMemoryContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const sections = new Set<AgentMemoryContextSection>(
      this.options.sections ?? ["agent_docs", "relationship_memory", "diary", "skills"],
    );
    let agentDocs: AgentWorkspaceDocSection[] | undefined;
    let relationshipMemory: string | undefined;
    let recentDiary: AgentWorkspaceDiaryEntry[] | undefined;
    let skills: AgentWorkspaceSkillEntry[] | undefined;

    if (sections.has("agent_docs")) {
      agentDocs = await Promise.all(
        AGENT_DOC_SLUGS.map(async (slug) => {
          const record = await this.options.store.readAgentPrompt(this.options.agentKey, slug);
          return {
            slug,
            content: record?.content ?? "",
          };
        }),
      );
    }

    if (sections.has("relationship_memory")) {
      const record = await this.options.store.readAgentDocument(
        this.options.agentKey,
        AGENT_DOCUMENT_SLUG,
        this.options.identityId,
      );
      relationshipMemory = record?.content ?? "";
    }

    if (sections.has("diary")) {
      recentDiary = [...await this.options.store.listDiaryEntries(
        this.options.agentKey,
        7,
        this.options.identityId,
      )].reverse().map((entry) => ({
        entryDate: entry.entryDate,
        content: entry.content || "",
      }));
    }

    if (sections.has("skills")) {
      skills = (await this.options.store.listAgentSkills(this.options.agentKey)).map((record) => ({
        skillKey: record.skillKey,
        description: record.description,
      }));
    }

    return renderAgentWorkspaceContext({
      agentKey: this.options.agentKey,
      agentDocs,
      relationshipMemory,
      recentDiary,
      skills,
    });
  }
}
