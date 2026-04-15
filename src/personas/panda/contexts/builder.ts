import type {LlmContext} from "../../../kernel/agent/llm-context.js";
import type {AgentStore} from "../../../domain/agents/store.js";
import type {ThreadRuntimeStore} from "../../../domain/threads/runtime/store.js";
import {AgentMemoryContext, type AgentMemoryContextSection} from "./agent-memory-context.js";
import {BackgroundJobsContext} from "./background-jobs-context.js";
import {DateTimeContext} from "./datetime-context.js";
import {EnvironmentContext} from "./environment-context.js";
import type {PandaSessionContext} from "../types.js";

export type PandaLlmContextSection =
  | "datetime"
  | "environment"
  | "background_jobs"
  | AgentMemoryContextSection;

const MEMORY_SECTIONS = new Set<AgentMemoryContextSection>([
  "agent_docs",
  "relationship_memory",
  "diary",
  "skills",
]);

export const DEFAULT_PANDA_LLM_CONTEXT_SECTIONS: readonly PandaLlmContextSection[] = [
  "datetime",
  "environment",
  "background_jobs",
  "agent_docs",
  "relationship_memory",
  "diary",
  "skills",
];

export interface BuildPandaLlmContextsOptions {
  context?: PandaSessionContext;
  agentStore?: AgentStore;
  threadStore?: Pick<ThreadRuntimeStore, "listBashJobs">;
  agentKey?: string;
  identityId?: string;
  threadId?: string;
  sections?: readonly PandaLlmContextSection[];
  extraLlmContexts?: readonly LlmContext[];
}

export {
  AgentMemoryContext,
  type AgentMemoryContextSection,
  type AgentMemoryContextOptions,
} from "./agent-memory-context.js";
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
    llmContexts.push(new DateTimeContext({
      timeZone: options.context?.timezone,
    }));
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

  const memorySections = [...uniqueSections]
    .filter((section): section is AgentMemoryContextSection => MEMORY_SECTIONS.has(section as AgentMemoryContextSection));
  if (
    memorySections.length > 0
    && options.agentStore
    && options.agentKey
  ) {
    llmContexts.push(new AgentMemoryContext({
      store: options.agentStore,
      agentKey: options.agentKey,
      identityId: options.identityId,
      sections: memorySections,
    }));
  }

  if (options.extraLlmContexts?.length) {
    llmContexts.push(...options.extraLlmContexts);
  }

  return llmContexts;
}
