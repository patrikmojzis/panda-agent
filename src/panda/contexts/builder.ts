import type {LlmContext} from "../../kernel/agent/llm-context.js";
import type {AgentStore} from "../../domain/agents/store.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {WikiBindingService} from "../../domain/wiki/index.js";
import {AgentProfileContext, type AgentProfileContextSection} from "./agent-profile-context.js";
import {BackgroundJobsContext} from "./background-jobs-context.js";
import {DateTimeContext} from "./datetime-context.js";
import {EnvironmentContext} from "./environment-context.js";
import {WikiOverviewContext} from "./wiki-overview-context.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";

export type DefaultAgentLlmContextSection =
  | "datetime"
  | "environment"
  | "wiki_overview"
  | "background_jobs"
  | AgentProfileContextSection;

const PROFILE_SECTIONS = new Set<AgentProfileContextSection>([
  "prompts",
  "skills",
]);

export const DEFAULT_AGENT_LLM_CONTEXT_SECTIONS: readonly DefaultAgentLlmContextSection[] = [
  "datetime",
  "environment",
  "wiki_overview",
  "background_jobs",
  "prompts",
  "skills",
];

export interface BuildDefaultAgentLlmContextsOptions {
  context?: DefaultAgentSessionContext;
  agentStore?: AgentStore;
  threadStore?: Pick<ThreadRuntimeStore, "listBashJobs">;
  wikiBindings?: Pick<WikiBindingService, "getBinding">;
  agentKey?: string;
  threadId?: string;
  sections?: readonly DefaultAgentLlmContextSection[];
  extraLlmContexts?: readonly LlmContext[];
}

export {
  AgentProfileContext,
  type AgentProfileContextSection,
  type AgentProfileContextOptions,
} from "./agent-profile-context.js";
export {DateTimeContext, type DateTimeContextOptions} from "./datetime-context.js";
export {EnvironmentContext, type EnvironmentContextOptions} from "./environment-context.js";

export function buildDefaultAgentLlmContexts(
  options: BuildDefaultAgentLlmContextsOptions,
): LlmContext[] {
  const sections = options.sections?.length
    ? [...options.sections]
    : [...DEFAULT_AGENT_LLM_CONTEXT_SECTIONS];
  const uniqueSections = new Set(sections);
  const llmContexts: LlmContext[] = [];

  if (uniqueSections.has("datetime")) {
    llmContexts.push(new DateTimeContext());
  }

  if (uniqueSections.has("environment")) {
    llmContexts.push(new EnvironmentContext({
      cwd: options.context?.cwd,
    }));
  }

  if (uniqueSections.has("wiki_overview") && options.agentKey && options.wikiBindings) {
    llmContexts.push(new WikiOverviewContext({
      agentKey: options.agentKey,
      bindings: options.wikiBindings,
    }));
  }

  if (uniqueSections.has("background_jobs") && options.threadStore && options.threadId) {
    llmContexts.push(new BackgroundJobsContext({
      store: options.threadStore,
      threadId: options.threadId,
    }));
  }

  const profileSections = [...uniqueSections]
    .filter((section): section is AgentProfileContextSection => PROFILE_SECTIONS.has(section as AgentProfileContextSection));
  if (
    profileSections.length > 0
    && options.agentStore
    && options.agentKey
  ) {
    llmContexts.push(new AgentProfileContext({
      store: options.agentStore,
      agentKey: options.agentKey,
      sections: profileSections,
    }));
  }

  if (options.extraLlmContexts?.length) {
    llmContexts.push(...options.extraLlmContexts);
  }

  return llmContexts;
}
