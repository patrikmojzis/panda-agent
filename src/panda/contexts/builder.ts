import type {LlmContext} from "../../kernel/agent/llm-context.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import type {ExecutionSkillPolicy} from "../../domain/execution-environments/types.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {SessionPromptRecord} from "../../domain/sessions/types.js";
import type {ScheduledTaskStore} from "../../domain/scheduling/tasks/store.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {WikiBindingService} from "../../domain/wiki/service.js";
import {AgentProfileContext, type AgentProfileContextSection, type AgentProfileStore} from "./agent-profile-context.js";
import {BackgroundJobsContext} from "./background-jobs-context.js";
import {DateTimeContext} from "./datetime-context.js";
import {EnvironmentContext} from "./environment-context.js";
import {ScheduledRemindersContext} from "./scheduled-reminders-context.js";
import {SessionBriefingContext} from "./session-briefing-context.js";
import {WorkersContext} from "./workers-context.js";
import {WikiOverviewContext} from "./wiki-overview-context.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";

export type DefaultAgentLlmContextSection =
  | "datetime"
  | "environment"
  | "scheduled_reminders"
  | "wiki_overview"
  | "background_jobs"
  | "workers"
  | "session_briefing"
  | AgentProfileContextSection;

const PROFILE_SECTIONS = new Set<AgentProfileContextSection>([
  "prompts",
  "skills",
]);

export const DEFAULT_AGENT_LLM_CONTEXT_SECTIONS: readonly DefaultAgentLlmContextSection[] = [
  "environment",
  "wiki_overview",
  "scheduled_reminders",
  "background_jobs",
  "workers",
  "prompts",
  "skills",
  "session_briefing",
];

export interface BuildDefaultAgentLlmContextsOptions {
  context?: DefaultAgentSessionContext;
  agentStore?: AgentProfileStore;
  sessionStore?: Partial<Pick<SessionStore, "listAgentSessions" | "readSessionPrompt">>;
  threadStore?: Pick<ThreadRuntimeStore, "listToolJobs">;
  scheduledTasks?: Pick<ScheduledTaskStore, "listActiveTasks">;
  executionEnvironments?: Pick<ExecutionEnvironmentStore, "listBindingsForEnvironments" | "listDisposableEnvironmentsByOwner">;
  wikiBindings?: Pick<WikiBindingService, "getBinding">;
  agentKey?: string;
  threadId?: string;
  sections?: readonly DefaultAgentLlmContextSection[];
  skillPolicy?: ExecutionSkillPolicy;
  sessionPrompt?: SessionPromptRecord | null;
  extraLlmContexts?: readonly LlmContext[];
}

export {
  AgentProfileContext,
  type AgentProfileContextSection,
  type AgentProfileContextOptions,
  type AgentProfileStore,
} from "./agent-profile-context.js";
export {DateTimeContext, type DateTimeContextOptions} from "./datetime-context.js";
export {SessionBriefingContext, type SessionBriefingContextOptions} from "./session-briefing-context.js";
export {EnvironmentContext, type EnvironmentContextOptions} from "./environment-context.js";
export {WorkersContext, type WorkersContextOptions} from "./workers-context.js";

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

  if (uniqueSections.has("scheduled_reminders") && options.context?.sessionId && options.scheduledTasks) {
    llmContexts.push(new ScheduledRemindersContext({
      store: options.scheduledTasks,
      sessionId: options.context.sessionId,
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

  if (
    uniqueSections.has("workers")
    && typeof options.sessionStore?.listAgentSessions === "function"
    && options.executionEnvironments
    && options.agentKey
    && options.context?.sessionId
  ) {
    llmContexts.push(new WorkersContext({
      sessions: options.sessionStore as Pick<SessionStore, "listAgentSessions">,
      environments: options.executionEnvironments,
      agentKey: options.agentKey,
      parentSessionId: options.context.sessionId,
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
      skillPolicy: options.skillPolicy,
    }));
  }

  if (uniqueSections.has("session_briefing") && options.context?.sessionId) {
    if (options.sessionPrompt !== undefined) {
      llmContexts.push(new SessionBriefingContext({
        sessionId: options.context.sessionId,
        prompt: options.sessionPrompt,
      }));
    } else if (typeof options.sessionStore?.readSessionPrompt === "function") {
      llmContexts.push(new SessionBriefingContext({
        sessionId: options.context.sessionId,
        store: options.sessionStore as Pick<SessionStore, "readSessionPrompt">,
      }));
    }
  }

  if (options.extraLlmContexts?.length) {
    llmContexts.push(...options.extraLlmContexts);
  }

  return llmContexts;
}
