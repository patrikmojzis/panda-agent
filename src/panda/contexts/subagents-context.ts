import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import type {
  ExecutionEnvironmentRecord,
  SessionEnvironmentBindingRecord,
} from "../../domain/execution-environments/types.js";
import type {ExecutionEnvironmentStore} from "../../domain/execution-environments/store.js";
import {readExecutionEnvironmentFilesystemMetadata} from "../../domain/execution-environments/filesystem.js";
import {readSubagentSessionMetadata, type SubagentExecutionMode} from "../../domain/subagents/session-metadata.js";
import type {SubagentProfileStore} from "../../domain/subagents/store.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {ThreadSummaryRecord} from "../../domain/threads/runtime/types.js";
import {
  renderSubagentsContext,
  type RenderSubagentsContextEnvironment,
  type RenderSubagentsContextOmittedGroup,
  type RenderSubagentsContextProfile,
  type RenderSubagentsContextSubagent,
} from "../../prompts/contexts/subagents.js";
import {resolveNow} from "./shared.js";

const STOPPED_ENVIRONMENT_CONTEXT_TTL_MS = 60 * 60 * 1_000;
const RECENT_SUBAGENT_ACTIVITY_MS = 24 * 60 * 60 * 1_000;
const MAX_RENDERED_ENVIRONMENTS = 12;
const MAX_RENDERED_SUBAGENTS_PER_ENVIRONMENT = 8;
const MAX_RENDERED_PROFILES = 20;
const MAX_TASK_PREVIEW_CHARS = 120;
const MAX_OMITTED_HISTORY_GROUPS = 8;
const MAX_OMITTED_HISTORY_VALUES = 4;
const CONTEXT_STATES = new Set(["provisioning", "ready", "stopping", "failed"]);

export interface SubagentsContextOptions {
  sessions: Pick<SessionStore, "listAgentSessions">;
  environments?: Pick<ExecutionEnvironmentStore, "listBindingsForEnvironments" | "listDisposableEnvironmentsByOwner">;
  subagentProfiles?: Pick<SubagentProfileStore, "listProfiles">;
  threads?: Pick<ThreadRuntimeStore, "listThreadSummaries">;
  agentKey: string;
  parentSessionId: string;
  stoppedTtlMs?: number;
  recentActivityMs?: number;
  maxSubagentsPerEnvironment?: number;
  maxProfiles?: number;
  now?: Date | (() => Date);
}

type OmittedSubagentCategory = "agent_workspace" | "isolated_environment" | "unavailable_environment";

interface SubagentContextCandidate {
  session: SessionRecord;
  subagent: RenderSubagentsContextSubagent;
  lastActivityAt: number;
  category: OmittedSubagentCategory;
  status?: string;
}

interface AttachedSubagentCandidate extends SubagentContextCandidate {
  binding: SessionEnvironmentBindingRecord;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

function taskPreview(task: string): string {
  const oneLine = task.replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_TASK_PREVIEW_CHARS
    ? `${oneLine.slice(0, MAX_TASK_PREVIEW_CHARS - 1)}…`
    : oneLine;
}

function shouldRenderEnvironment(environment: ExecutionEnvironmentRecord, now: number, stoppedTtlMs: number): boolean {
  if (CONTEXT_STATES.has(environment.state)) {
    return true;
  }
  return environment.state === "stopped" && environment.updatedAt >= now - stoppedTtlMs;
}

function resolveMaxSubagentsPerEnvironment(maxSubagents: number | undefined): number {
  if (maxSubagents === undefined || !Number.isFinite(maxSubagents)) {
    return MAX_RENDERED_SUBAGENTS_PER_ENVIRONMENT;
  }
  return Math.max(1, Math.floor(maxSubagents));
}

function compareAttachedSubagentCandidates(
  left: AttachedSubagentCandidate,
  right: AttachedSubagentCandidate,
): number {
  const activityDelta = right.lastActivityAt - left.lastActivityAt;
  if (activityDelta !== 0) {
    return activityDelta;
  }

  const bindingCreatedAtDelta = right.binding.createdAt - left.binding.createdAt;
  if (bindingCreatedAtDelta !== 0) {
    return bindingCreatedAtDelta;
  }

  const sessionCreatedAtDelta = right.session.createdAt - left.session.createdAt;
  if (sessionCreatedAtDelta !== 0) {
    return sessionCreatedAtDelta;
  }

  return left.session.id.localeCompare(right.session.id);
}

function compareSubagentCandidates(left: SubagentContextCandidate, right: SubagentContextCandidate): number {
  const activityDelta = right.lastActivityAt - left.lastActivityAt;
  if (activityDelta !== 0) {
    return activityDelta;
  }

  const sessionCreatedAtDelta = right.session.createdAt - left.session.createdAt;
  if (sessionCreatedAtDelta !== 0) {
    return sessionCreatedAtDelta;
  }

  return left.session.id.localeCompare(right.session.id);
}

function selectRenderedSubagents(
  candidates: readonly AttachedSubagentCandidate[],
  maxSubagents: number,
): Pick<RenderSubagentsContextEnvironment, "subagents" | "omittedSubagentCount"> {
  if (candidates.length <= maxSubagents) {
    return {
      subagents: candidates.map((candidate) => candidate.subagent),
    };
  }

  const subagents = [...candidates]
    .sort(compareAttachedSubagentCandidates)
    .slice(0, maxSubagents)
    .map((candidate) => candidate.subagent);
  return {
    subagents,
    omittedSubagentCount: candidates.length - subagents.length,
  };
}

function readPathHints(environment: ExecutionEnvironmentRecord): Pick<
  RenderSubagentsContextEnvironment,
  "workspacePath" | "inboxPath" | "artifactsPath"
> {
  const filesystem = readExecutionEnvironmentFilesystemMetadata(environment.metadata);
  return {
    ...(filesystem?.workspace.parentRunnerPath ? {workspacePath: filesystem.workspace.parentRunnerPath} : {}),
    ...(filesystem?.inbox.parentRunnerPath ? {inboxPath: filesystem.inbox.parentRunnerPath} : {}),
    ...(filesystem?.artifacts.parentRunnerPath ? {artifactsPath: filesystem.artifacts.parentRunnerPath} : {}),
  };
}

function renderExecutionMode(value: SubagentExecutionMode): "agent_workspace" | "isolated_environment" {
  return value;
}

function threadSummaryActivity(summary: ThreadSummaryRecord): number {
  return Math.max(
    summary.thread.updatedAt,
    summary.lastMessage?.createdAt ?? 0,
  );
}

function buildThreadActivityBySessionId(summaries: readonly ThreadSummaryRecord[]): Map<string, number> {
  const bySessionId = new Map<string, number>();
  for (const summary of summaries) {
    const activity = threadSummaryActivity(summary);
    const previous = bySessionId.get(summary.thread.sessionId) ?? 0;
    if (activity > previous) {
      bySessionId.set(summary.thread.sessionId, activity);
    }
  }
  return bySessionId;
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function compactCounts(counts: Map<string, number>): readonly string[] {
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, MAX_OMITTED_HISTORY_VALUES)
    .map(([value, count]) => `${value}:${count}`);
}

function summarizeOmittedHistory(
  candidates: readonly SubagentContextCandidate[],
  cutoff: number,
): {count: number; cutoff: string; groups: readonly RenderSubagentsContextOmittedGroup[]} | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  const groupsByCategory = new Map<OmittedSubagentCategory, SubagentContextCandidate[]>();
  for (const candidate of candidates) {
    const group = groupsByCategory.get(candidate.category) ?? [];
    group.push(candidate);
    groupsByCategory.set(candidate.category, group);
  }

  const groups = [...groupsByCategory.entries()]
    .map(([category, group]) => ({
      category,
      count: group.length,
      statuses: compactCounts(countBy(group.flatMap((candidate) => candidate.status ? [candidate.status] : []))),
      profiles: compactCounts(countBy(group.map((candidate) => candidate.subagent.profile))),
    }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
    .slice(0, MAX_OMITTED_HISTORY_GROUPS);

  return {
    count: candidates.length,
    cutoff: formatTimestamp(cutoff),
    groups,
  };
}

function findBindingForSubagent(
  bindings: readonly SessionEnvironmentBindingRecord[],
  sessionId: string,
  environmentId: string | undefined,
): SessionEnvironmentBindingRecord | undefined {
  return bindings.find((binding) => (
    binding.sessionId === sessionId
    && (environmentId === undefined || binding.environmentId === environmentId)
  ));
}

function unavailableEnvironmentStatus(input: {
  environmentId?: string;
  environment?: ExecutionEnvironmentRecord;
  binding?: SessionEnvironmentBindingRecord;
}): string {
  if (!input.environmentId) {
    return "missing_environment_id";
  }
  if (!input.environment) {
    return "missing_environment";
  }
  if (!input.binding) {
    return "unbound";
  }
  return input.environment.state;
}

export class SubagentsContext extends LlmContext {
  override name = "Subagents";

  private readonly options: SubagentsContextOptions;

  constructor(options: SubagentsContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const now = resolveNow(this.options.now).getTime();
    const stoppedTtlMs = this.options.stoppedTtlMs ?? STOPPED_ENVIRONMENT_CONTEXT_TTL_MS;
    const recentActivityMs = this.options.recentActivityMs ?? RECENT_SUBAGENT_ACTIVITY_MS;
    const recentCutoff = now - recentActivityMs;
    const maxSubagentsPerEnvironment = resolveMaxSubagentsPerEnvironment(this.options.maxSubagentsPerEnvironment);
    const maxProfiles = Math.max(1, Math.floor(this.options.maxProfiles ?? MAX_RENDERED_PROFILES));
    const [sessions, environments, profiles, threadSummaries] = await Promise.all([
      this.options.sessions.listAgentSessions(this.options.agentKey),
      this.options.environments
        ? this.options.environments.listDisposableEnvironmentsByOwner({
          agentKey: this.options.agentKey,
          createdBySessionId: this.options.parentSessionId,
        })
        : Promise.resolve([]),
      this.options.subagentProfiles
        ? this.options.subagentProfiles.listProfiles({agentKey: this.options.agentKey})
        : Promise.resolve([]),
      this.options.threads
        ? this.options.threads.listThreadSummaries()
        : Promise.resolve([]),
    ]);
    const threadActivityBySessionId = buildThreadActivityBySessionId(threadSummaries);
    const environmentsById = new Map(environments.map((environment) => [environment.id, environment]));
    const visibleEnvironments = environments.filter((environment) => (
      shouldRenderEnvironment(environment, now, stoppedTtlMs)
    ));
    const visibleEnvironmentIds = new Set(visibleEnvironments.map((environment) => environment.id));
    const bindings = this.options.environments
      ? await this.options.environments.listBindingsForEnvironments(
        environments.map((environment) => environment.id),
      )
      : [];
    const subagentsBySessionId = new Map<string, SubagentContextCandidate>();
    const agentWorkspaceSubagents: SubagentContextCandidate[] = [];
    const omittedHistoryCandidates: SubagentContextCandidate[] = [];

    for (const session of sessions) {
      if (session.kind !== "subagent") {
        continue;
      }
      const metadata = readSubagentSessionMetadata(session.metadata);
      if (metadata?.parentSessionId !== this.options.parentSessionId) {
        continue;
      }

      const environment = metadata.environmentId ? environmentsById.get(metadata.environmentId) : undefined;
      const binding = findBindingForSubagent(bindings, session.id, metadata.environmentId);
      const isVisibleBoundEnvironment = Boolean(
        metadata.environmentId
        && environment
        && binding
        && visibleEnvironmentIds.has(metadata.environmentId),
      );
      const category: OmittedSubagentCategory = metadata.execution === "agent_workspace"
        ? "agent_workspace"
        : isVisibleBoundEnvironment
          ? "isolated_environment"
          : "unavailable_environment";
      const status = category === "agent_workspace"
        ? undefined
        : category === "isolated_environment"
          ? environment?.state
          : unavailableEnvironmentStatus({environmentId: metadata.environmentId, environment, binding});
      const lastActivityAt = Math.max(
        session.createdAt,
        session.updatedAt,
        threadActivityBySessionId.get(session.id) ?? 0,
        binding?.updatedAt ?? 0,
        environment?.updatedAt ?? 0,
      );
      const rendered = {
        sessionId: session.id,
        profile: metadata.profile.slug,
        execution: renderExecutionMode(metadata.execution),
        startedAt: formatTimestamp(session.createdAt),
        lastActivityAt: formatTimestamp(lastActivityAt),
        task: taskPreview(metadata.task),
        ...(metadata.environmentId ? {environmentId: metadata.environmentId} : {}),
      } satisfies RenderSubagentsContextSubagent;
      const candidate = {session, subagent: rendered, lastActivityAt, category, status};

      if (category === "unavailable_environment" || lastActivityAt < recentCutoff) {
        omittedHistoryCandidates.push(candidate);
        continue;
      }

      subagentsBySessionId.set(session.id, candidate);
      if (category === "agent_workspace") {
        agentWorkspaceSubagents.push(candidate);
      }
    }

    const renderedEnvironments: RenderSubagentsContextEnvironment[] = [];
    for (const environment of visibleEnvironments) {
      const attachedSubagents = bindings
        .filter((binding: SessionEnvironmentBindingRecord) => binding.environmentId === environment.id)
        .flatMap((binding): AttachedSubagentCandidate[] => {
          const subagent = subagentsBySessionId.get(binding.sessionId);
          return subagent ? [{...subagent, binding}] : [];
        });
      if (attachedSubagents.length === 0) {
        continue;
      }
      renderedEnvironments.push({
        environmentId: environment.id,
        state: environment.state,
        networkPolicy: environment.networkPolicy,
        startedAt: formatTimestamp(environment.createdAt),
        updatedAt: formatTimestamp(environment.updatedAt),
        ...readPathHints(environment),
        ...selectRenderedSubagents(attachedSubagents, maxSubagentsPerEnvironment),
      });
    }

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
      agentWorkspaceSubagents: [...agentWorkspaceSubagents]
        .sort(compareSubagentCandidates)
        .map((candidate) => candidate.subagent),
      environments: renderedEnvironments
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, MAX_RENDERED_ENVIRONMENTS),
      omittedHistory: summarizeOmittedHistory(omittedHistoryCandidates, recentCutoff),
    });
  }
}
