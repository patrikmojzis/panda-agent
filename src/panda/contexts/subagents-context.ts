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
import {
  renderSubagentsContext,
  type RenderSubagentsContextEnvironment,
  type RenderSubagentsContextProfile,
  type RenderSubagentsContextSubagent,
} from "../../prompts/contexts/subagents.js";
import {resolveNow} from "./shared.js";

const STOPPED_ENVIRONMENT_CONTEXT_TTL_MS = 60 * 60 * 1_000;
const MAX_RENDERED_ENVIRONMENTS = 12;
const MAX_RENDERED_SUBAGENTS_PER_ENVIRONMENT = 8;
const MAX_RENDERED_PROFILES = 20;
const MAX_TASK_PREVIEW_CHARS = 120;
const CONTEXT_STATES = new Set(["provisioning", "ready", "stopping", "failed"]);

export interface SubagentsContextOptions {
  sessions: Pick<SessionStore, "listAgentSessions">;
  environments?: Pick<ExecutionEnvironmentStore, "listBindingsForEnvironments" | "listDisposableEnvironmentsByOwner">;
  subagentProfiles?: Pick<SubagentProfileStore, "listProfiles">;
  agentKey: string;
  parentSessionId: string;
  stoppedTtlMs?: number;
  maxSubagentsPerEnvironment?: number;
  maxProfiles?: number;
  now?: Date | (() => Date);
}

interface SubagentContextCandidate {
  session: SessionRecord;
  subagent: RenderSubagentsContextSubagent;
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
    const maxSubagentsPerEnvironment = resolveMaxSubagentsPerEnvironment(this.options.maxSubagentsPerEnvironment);
    const maxProfiles = Math.max(1, Math.floor(this.options.maxProfiles ?? MAX_RENDERED_PROFILES));
    const [sessions, environments, profiles] = await Promise.all([
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
    ]);
    const visibleEnvironments = environments.filter((environment) => (
      shouldRenderEnvironment(environment, now, stoppedTtlMs)
    ));
    const bindings = this.options.environments
      ? await this.options.environments.listBindingsForEnvironments(
        visibleEnvironments.map((environment) => environment.id),
      )
      : [];
    const visibleEnvironmentIds = new Set(visibleEnvironments.map((environment) => environment.id));
    const boundSessionIds = new Set(bindings.map((binding) => binding.sessionId));
    const subagentsBySessionId = new Map<string, SubagentContextCandidate>();
    const agentWorkspaceSubagents: SubagentContextCandidate[] = [];
    const unavailableEnvironmentSubagents: SubagentContextCandidate[] = [];

    for (const session of sessions) {
      if (session.kind !== "subagent") {
        continue;
      }
      const metadata = readSubagentSessionMetadata(session.metadata);
      if (metadata?.parentSessionId !== this.options.parentSessionId) {
        continue;
      }
      const rendered = {
        sessionId: session.id,
        profile: metadata.profile.slug,
        execution: renderExecutionMode(metadata.execution),
        startedAt: formatTimestamp(session.createdAt),
        task: taskPreview(metadata.task),
        ...(metadata.environmentId ? {environmentId: metadata.environmentId} : {}),
      } satisfies RenderSubagentsContextSubagent;
      const candidate = {session, subagent: rendered};
      subagentsBySessionId.set(session.id, candidate);
      if (metadata.execution === "agent_workspace") {
        agentWorkspaceSubagents.push(candidate);
      } else if (metadata.environmentId && !visibleEnvironmentIds.has(metadata.environmentId)) {
        unavailableEnvironmentSubagents.push(candidate);
      } else if (!metadata.environmentId || !boundSessionIds.has(session.id)) {
        unavailableEnvironmentSubagents.push(candidate);
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
      renderedEnvironments.push({
        environmentId: environment.id,
        state: environment.state,
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
      environments: renderedEnvironments.slice(-MAX_RENDERED_ENVIRONMENTS),
      unavailableEnvironmentSubagents: [...unavailableEnvironmentSubagents]
        .sort(compareSubagentCandidates)
        .map((candidate) => candidate.subagent),
    });
  }
}
