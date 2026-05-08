import {LlmContext} from "../../kernel/agent/llm-context.js";
import {
    type AgentProfilePromptEntry,
    type AgentProfileSkillEntry,
    renderAgentProfileContext,
} from "../../prompts/contexts/agent-profile.js";
import type {AgentStore} from "../../domain/agents/store.js";
import {normalizeSkillKey} from "../../domain/agents/types.js";
import type {ExecutionSkillPolicy} from "../../domain/execution-environments/index.js";

// Heartbeat guidance should only show up on heartbeat wakes, not in every normal run.
const AGENT_PROMPT_SLUGS = ["agent"] as const;

export type AgentProfileContextSection =
  | "prompts"
  | "skills";

export interface AgentProfileContextOptions {
  store: AgentStore;
  agentKey: string;
  sections?: readonly AgentProfileContextSection[];
  skillPolicy?: ExecutionSkillPolicy;
}

export class AgentProfileContext extends LlmContext {
  override name = "Agent Profile";

  private readonly options: AgentProfileContextOptions;

  constructor(options: AgentProfileContextOptions) {
    super();
    this.options = options;
  }

  private filterSkillEntries(entries: AgentProfileSkillEntry[]): AgentProfileSkillEntry[] {
    const policy = this.options.skillPolicy ?? {mode: "all_agent" as const};
    if (policy.mode === "all_agent") {
      return entries;
    }
    if (policy.mode === "none") {
      return [];
    }

    const allowed = new Set(policy.skillKeys.map((key) => normalizeSkillKey(key)));
    return entries.filter((entry) => allowed.has(normalizeSkillKey(entry.skillKey)));
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
      skills = this.filterSkillEntries((await this.options.store.listAgentSkills(this.options.agentKey)).map((record) => ({
        skillKey: record.skillKey,
        description: record.description,
      })));
    }

    return renderAgentProfileContext({
      agentKey: this.options.agentKey,
      prompts,
      skills,
    });
  }
}
