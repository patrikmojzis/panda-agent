import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {SubagentProfileStore} from "../../domain/subagents/store.js";
import {
  renderSubagentsContext,
  type RenderSubagentsContextProfile,
} from "../../prompts/contexts/subagents.js";

const MAX_RENDERED_PROFILES = 20;

export interface SubagentsContextOptions {
  subagentProfiles: Pick<SubagentProfileStore, "listProfiles">;
  agentKey: string;
  maxProfiles?: number;
}

export class SubagentsContext extends LlmContext {
  override name = "Subagents";

  private readonly options: SubagentsContextOptions;

  constructor(options: SubagentsContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const maxProfiles = Math.max(1, Math.floor(this.options.maxProfiles ?? MAX_RENDERED_PROFILES));
    const profiles = await this.options.subagentProfiles.listProfiles({
      agentKey: this.options.agentKey,
    });
    const renderedProfiles: RenderSubagentsContextProfile[] = profiles.slice(0, maxProfiles).map((profile) => ({
      slug: profile.slug,
      source: profile.source,
      description: profile.description,
      toolGroups: profile.toolGroups,
      ...(profile.model ? {model: profile.model} : {}),
      ...(profile.thinking ? {thinking: profile.thinking} : {}),
    }));

    return renderSubagentsContext({
      profiles: renderedProfiles,
      omittedProfileCount: Math.max(0, profiles.length - renderedProfiles.length),
    });
  }
}
