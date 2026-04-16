import type {LlmContext} from "../../kernel/agent/llm-context.js";
import type {AgentStore} from "../../domain/agents/store.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {AgentProfileContext, type AgentProfileContextSection} from "./agent-profile-context.js";
import {BackgroundJobsContext} from "./background-jobs-context.js";
import {DateTimeContext} from "./datetime-context.js";
import {EnvironmentContext} from "./environment-context.js";
import type {PandaSessionContext} from "../../app/runtime/panda-session-context.js";

export type PandaLlmContextSection =
  | "datetime"
  | "environment"
  | "background_jobs"
  | AgentProfileContextSection;

const PROFILE_SECTIONS = new Set<AgentProfileContextSection>([
  "prompts",
  "skills",
]);

export const DEFAULT_PANDA_LLM_CONTEXT_SECTIONS: readonly PandaLlmContextSection[] = [
  "datetime",
  "environment",
  "background_jobs",
  "prompts",
  "skills",
];

export interface BuildPandaLlmContextsOptions {
  context?: PandaSessionContext;
  agentStore?: AgentStore;
  threadStore?: Pick<ThreadRuntimeStore, "listBashJobs">;
  agentKey?: string;
  threadId?: string;
  sections?: readonly PandaLlmContextSection[];
  extraLlmContexts?: readonly LlmContext[];
}

export {
  AgentProfileContext,
  type AgentProfileContextSection,
  type AgentProfileContextOptions,
} from "./agent-profile-context.js";
export {DateTimeContext, type DateTimeContextOptions} from "./datetime-context.js";
export {EnvironmentContext, type EnvironmentContextOptions} from "./environment-context.js";

export function buildPandaLlmContexts(
  options: BuildPandaLlmContextsOptions,
): LlmContext[] {
  const sections = options.sections?.length
    ? [...options.sections]
    : [...DEFAULT_PANDA_LLM_CONTEXT_SECTIONS];
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
