import {LlmContext} from "../../kernel/agent/llm-context.js";
import {
    type AgentProfileSkillEntry,
    renderAgentProfileContext,
} from "../../prompts/contexts/agent-profile.js";
import type {AgentStore} from "../../domain/agents/store.js";
import {normalizeSkillKey} from "../../domain/agents/types.js";
import type {ExecutionSkillPolicy} from "../../domain/execution-environments/types.js";

export type AgentProfileContextSection =
  | "skills";

export type AgentProfileStore = Pick<AgentStore, "listAgentSkills">;

export interface AgentProfileContextOptions {
  store: AgentProfileStore;
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
      this.options.sections ?? ["skills"],
    );
    let skills: AgentProfileSkillEntry[] | undefined;

    if (sections.has("skills")) {
      skills = this.filterSkillEntries((await this.options.store.listAgentSkills(this.options.agentKey)).map((record) => ({
        skillKey: record.skillKey,
        description: record.description,
        tags: record.tags,
      })));
    }

    return renderAgentProfileContext({
      agentKey: this.options.agentKey,
      skills,
    });
  }
}
