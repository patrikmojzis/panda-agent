import {LlmContext} from "../../kernel/agent/llm-context.js";
import {
    type AgentProfilePromptEntry,
    type AgentProfileSkillEntry,
    renderAgentProfileContext,
} from "../../prompts/contexts/agent-profile.js";
import type {AgentStore} from "../../domain/agents/store.js";

// Heartbeat guidance should only show up on heartbeat wakes, not in every normal run.
const AGENT_PROMPT_SLUGS = ["agent", "soul"] as const;

export type AgentProfileContextSection =
  | "prompts"
  | "skills";

export interface AgentProfileContextOptions {
  store: AgentStore;
  agentKey: string;
  sections?: readonly AgentProfileContextSection[];
}

export class AgentProfileContext extends LlmContext {
  override name = "Agent Profile";

  private readonly options: AgentProfileContextOptions;

  constructor(options: AgentProfileContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const sections = new Set<AgentProfileContextSection>(
      this.options.sections ?? ["prompts", "skills"],
    );
    let prompts: AgentProfilePromptEntry[] | undefined;
    let skills: AgentProfileSkillEntry[] | undefined;

    if (sections.has("prompts")) {
      prompts = await Promise.all(
        AGENT_PROMPT_SLUGS.map(async (slug) => {
          const record = await this.options.store.readAgentPrompt(this.options.agentKey, slug);
          return {
            slug,
            content: record?.content ?? "",
          };
        }),
      );
    }

    if (sections.has("skills")) {
      skills = (await this.options.store.listAgentSkills(this.options.agentKey)).map((record) => ({
        skillKey: record.skillKey,
        description: record.description,
      }));
    }

    return renderAgentProfileContext({
      agentKey: this.options.agentKey,
      prompts,
      skills,
    });
  }
}
