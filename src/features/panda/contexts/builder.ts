import type {LlmContext} from "../../agent-core/llm-context.js";
import type {AgentStore} from "../../agents/store.js";
import {AgentMemoryContext, type AgentMemoryContextSection} from "./agent-memory-context.js";
import {DateTimeContext} from "./datetime-context.js";
import {EnvironmentContext} from "./environment-context.js";
import type {PandaSessionContext} from "../types.js";

export type PandaLlmContextSection =
  | "datetime"
  | "environment"
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
  "agent_docs",
  "relationship_memory",
  "diary",
  "skills",
];

export interface BuildPandaLlmContextsOptions {
  context?: PandaSessionContext;
  agentStore?: AgentStore;
  agentKey?: string;
  identityId?: string;
  skillsDir?: string;
  sections?: readonly PandaLlmContextSection[];
  extraLlmContexts?: readonly LlmContext[];
}

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

  const memorySections = [...uniqueSections]
    .filter((section): section is AgentMemoryContextSection => MEMORY_SECTIONS.has(section as AgentMemoryContextSection));
  if (
    memorySections.length > 0
    && options.agentStore
    && options.agentKey
    && options.identityId
  ) {
    llmContexts.push(new AgentMemoryContext({
      store: options.agentStore,
      agentKey: options.agentKey,
      identityId: options.identityId,
      skillsDir: options.skillsDir,
      sections: memorySections,
    }));
  }

  if (options.extraLlmContexts?.length) {
    llmContexts.push(...options.extraLlmContexts);
  }

  return llmContexts;
}
