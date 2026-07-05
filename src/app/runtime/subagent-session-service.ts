import {randomUUID} from "node:crypto";

import type {ThinkingLevel} from "@earendil-works/pi-ai";

import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {ConfigurationError} from "../../kernel/agent/exceptions.js";
import {resolveModelSelector} from "../../kernel/models/model-selector.js";
import type {BindA2ASessionInput, A2ASessionBindingRecord} from "../../domain/a2a/types.js";
import type {
  ExecutionCredentialPolicy,
  ExecutionEnvironmentRecord,
  ExecutionSkillPolicy,
  ExecutionToolPolicy,
  SessionEnvironmentBindingRecord,
} from "../../domain/execution-environments/types.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import {buildSessionTableNames} from "../../domain/sessions/postgres-shared.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {
  CreateSessionInput,
  SessionRecord,
  UpdateSessionRuntimeConfigInput,
} from "../../domain/sessions/types.js";
import {createSessionWithInitialThread} from "../../domain/sessions/lifecycle.js";
import type {SubagentProfileStore} from "../../domain/subagents/store.js";
import {
  buildAdHocSubagentProfileSnapshot,
  buildSubagentProfileSnapshot,
  buildSubagentSessionMetadata,
  type SubagentExecutionMode,
  type SubagentProfileSnapshot,
  type SubagentResolvedModelSource,
} from "../../domain/subagents/session-metadata.js";
import {normalizeSubagentProfileSlug} from "../../domain/subagents/types.js";
import {
  normalizeSubagentToolGroups,
  resolveSubagentToolPolicy,
} from "../../domain/subagents/tool-groups.js";
import type {CommandPolicyModule} from "../../domain/commands/types.js";
import type {CommandCatalog} from "../../domain/commands/modules.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {CreateThreadInput, InferenceProjection, ThreadRecord} from "../../domain/threads/runtime/types.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import {trimToUndefined, uniqueTrimmedStrings} from "../../lib/strings.js";
import {renderSubagentHandoff} from "../../prompts/runtime/subagents.js";
import type {CreateDisposableSessionEnvironmentResult} from "./execution-environment-service.js";

const SUBAGENT_INPUT_SOURCE = "subagent";
const DEFAULT_SUBAGENT_PROFILE = "workspace";

type SubagentRuntimeConfig = Omit<UpdateSessionRuntimeConfigInput, "sessionId">;

type SubagentSessionStore = Pick<
  SessionStore,
  "createSession" | "getSession" | "updateSessionRuntimeConfig"
>;

type SubagentThreadStore = Pick<ThreadRuntimeStore, "createThread" | "enqueueInput">;

type SubagentEnvironmentAttacher = {
  attachReadySessionToDisposableEnvironment(input: {
    session: Pick<SessionRecord, "id" | "agentKey">;
    environmentId: string;
    ownerSessionId: string;
    alias?: string;
    isDefault?: boolean;
    credentialPolicy?: ExecutionCredentialPolicy;
    skillPolicy?: ExecutionSkillPolicy;
    toolPolicy?: ExecutionToolPolicy;
  }): Promise<CreateDisposableSessionEnvironmentResult>;
};

export interface CreateSubagentSessionInput {
  agentKey: string;
  parentSessionId: string;
  task: string;
  context?: string;
  profile?: string;
  toolGroups?: readonly string[];
  execution?: SubagentExecutionMode;
  environmentId?: string;
  credentialAllowlist?: readonly string[];
  sessionId?: string;
  threadId?: string;
  createdByIdentityId?: string;
  model?: string;
  thinking?: ThinkingLevel | null;
  inferenceProjection?: InferenceProjection;
  deliveryMode?: "queue" | "wake";
}

export interface CreateSubagentSessionResult {
  session: SessionRecord;
  thread: ThreadRecord;
  environment?: ExecutionEnvironmentRecord;
  binding?: SessionEnvironmentBindingRecord;
}

export interface SubagentSessionServiceOptions {
  pool?: PgPoolLike;
  sessions: SubagentSessionStore;
  threads: SubagentThreadStore;
  profiles: SubagentProfileStore;
  environments?: SubagentEnvironmentAttacher;
  a2aBindings: {
    bindSession(input: BindA2ASessionInput): Promise<A2ASessionBindingRecord>;
  };
  commandCatalog?: Pick<CommandCatalog, "namesForToolGroups">;
  commandModules?: readonly CommandPolicyModule[];
  coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;
}

function requireTrimmed(field: string, value: string | undefined): string {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    throw new Error(`Subagent session ${field} must not be empty.`);
  }
  return trimmed;
}

function resolveModel(value: string | undefined): {model?: string; source?: SubagentResolvedModelSource} {
  const selector = trimToUndefined(value);
  if (!selector) {
    return {};
  }
  try {
    return {
      model: resolveModelSelector(selector).canonical,
      source: "spawn",
    };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw new Error(`Invalid subagent model ${JSON.stringify(selector)}: ${error.message}`);
    }
    throw error;
  }
}

function resolveProfileModel(profile: SubagentProfileSnapshot): {model?: string; source?: SubagentResolvedModelSource} {
  return profile.model ? {model: profile.model, source: "profile"} : {};
}

function buildCredentialPolicy(input: CreateSubagentSessionInput): ExecutionCredentialPolicy {
  return {
    mode: "allowlist",
    envKeys: uniqueTrimmedStrings(input.credentialAllowlist ?? []),
  };
}

function buildSkillPolicy(): ExecutionSkillPolicy {
  return {mode: "all_agent"};
}

function buildRuntimeConfig(input: {
  model?: string;
  thinking?: ThinkingLevel | null;
  inferenceProjection?: InferenceProjection;
}): SubagentRuntimeConfig | undefined {
  const runtimeConfig = {
    ...(input.model !== undefined ? {model: input.model} : {}),
    ...(input.thinking !== undefined ? {thinking: input.thinking} : {}),
    ...(input.inferenceProjection !== undefined ? {inferenceProjection: input.inferenceProjection} : {}),
  } satisfies SubagentRuntimeConfig;
  return Object.keys(runtimeConfig).length > 0 ? runtimeConfig : undefined;
}

export class SubagentSessionService {
  private readonly pool?: PgPoolLike;
  private readonly sessions: SubagentSessionStore;
  private readonly threads: SubagentThreadStore;
  private readonly profiles: SubagentProfileStore;
  private readonly environments?: SubagentEnvironmentAttacher;
  private readonly a2aBindings: SubagentSessionServiceOptions["a2aBindings"];
  private readonly commandCatalog?: Pick<CommandCatalog, "namesForToolGroups">;
  private readonly commandModules: readonly CommandPolicyModule[];
  private readonly coordinator?: Pick<ThreadRuntimeCoordinator, "submitInput">;

  constructor(options: SubagentSessionServiceOptions) {
    this.pool = options.pool;
    this.sessions = options.sessions;
    this.threads = options.threads;
    this.profiles = options.profiles;
    this.environments = options.environments;
    this.a2aBindings = options.a2aBindings;
    if (options.commandCatalog && options.commandModules) {
      throw new Error("Pass either commandCatalog or commandModules, not both.");
    }
    this.commandCatalog = options.commandCatalog;
    this.commandModules = options.commandModules ?? [];
    this.coordinator = options.coordinator;
  }

  async createSubagentSession(input: CreateSubagentSessionInput): Promise<CreateSubagentSessionResult> {
    if (input.profile !== undefined && input.toolGroups !== undefined) {
      throw new Error("Subagent profile toolGroups cannot be overridden. Omit profile for an ad-hoc toolGroups plan.");
    }

    const agentKey = requireTrimmed("agentKey", input.agentKey);
    const parentSessionId = requireTrimmed("parentSessionId", input.parentSessionId);
    await this.assertValidParentSession({agentKey, parentSessionId});
    const task = requireTrimmed("task", input.task);
    const execution = input.execution ?? "agent_workspace";
    const environmentId = trimToUndefined(input.environmentId);
    if (execution === "isolated_environment" && !environmentId) {
      throw new Error("Isolated subagent execution requires environmentId.");
    }
    if (execution === "agent_workspace" && environmentId) {
      throw new Error("agent_workspace subagent execution must not set environmentId.");
    }

    const resolvedProfile = await this.resolveProfile(input, agentKey);
    const spawnModel = resolveModel(input.model);
    const profileModel = spawnModel.model ? {} : resolveProfileModel(resolvedProfile.profile);
    const resolvedModel = spawnModel.model ? spawnModel : profileModel;
    const credentialPolicy = buildCredentialPolicy(input);
    const skillPolicy = buildSkillPolicy();
    const toolPolicy = resolveSubagentToolPolicy(resolvedProfile.profile.toolGroups, {
      ...(this.commandCatalog ? {commandCatalog: this.commandCatalog} : {}),
      ...(!this.commandCatalog ? {commandModules: this.commandModules} : {}),
    });
    const thinking = input.thinking !== undefined
      ? input.thinking ?? undefined
      : resolvedProfile.profile.thinking;
    const metadata = buildSubagentSessionMetadata({
      role: resolvedProfile.profile.slug,
      task,
      context: input.context,
      parentSessionId,
      execution,
      ...(environmentId ? {environmentId} : {}),
      profile: resolvedProfile.profile,
      resolved: {
        ...(resolvedModel.model ? {model: resolvedModel.model} : {}),
        ...(resolvedModel.source ? {modelSource: resolvedModel.source} : {}),
        ...(thinking ? {thinking} : {}),
        credentialPolicy,
        skillPolicy,
        toolPolicy,
      },
    });

    const sessionId = trimToUndefined(input.sessionId) ?? randomUUID();
    const threadId = trimToUndefined(input.threadId) ?? randomUUID();
    const runtimeConfig = buildRuntimeConfig({
      model: resolvedModel.model,
      thinking,
      inferenceProjection: input.inferenceProjection,
    });
    const created = await this.createSessionAndThread({
      id: sessionId,
      agentKey,
      kind: "subagent",
      currentThreadId: threadId,
      createdByIdentityId: input.createdByIdentityId,
      metadata,
    }, {
      id: threadId,
      sessionId,
    }, runtimeConfig);

    try {
      const attached = execution === "isolated_environment"
        ? await this.attachEnvironment({
          session: created.session,
          environmentId: environmentId ?? "",
          ownerSessionId: parentSessionId,
          credentialPolicy,
          skillPolicy,
          toolPolicy,
        })
        : undefined;

      await this.bindParentSubagent(parentSessionId, created.session.id);
      await this.enqueueHandoff({
        threadId: created.thread.id,
        task,
        context: input.context,
        identityId: input.createdByIdentityId,
        parentSessionId,
        role: resolvedProfile.profile.slug,
        deliveryMode: input.deliveryMode ?? "wake",
      });

      return {
        session: created.session,
        thread: created.thread,
        ...(attached ? {environment: attached.environment, binding: attached.binding} : {}),
      };
    } catch (error) {
      await this.deleteCreatedSubagentSession(created.session.id, created.thread.id).catch(() => {});
      throw error;
    }
  }

  private async assertValidParentSession(input: {agentKey: string; parentSessionId: string}): Promise<void> {
    let parent: SessionRecord;
    try {
      parent = await this.sessions.getSession(input.parentSessionId);
    } catch {
      throw new Error(`Subagent parent session ${input.parentSessionId} was not found.`);
    }

    if (parent.agentKey !== input.agentKey) {
      throw new Error(`Subagent session agent ${input.agentKey} must match parent session agent ${parent.agentKey}.`);
    }

    if (parent.kind === "subagent") {
      throw new Error("Nested subagents are disabled; parent session is a subagent.");
    }

    if (parent.kind === "worker") {
      throw new Error("Legacy worker sessions cannot be subagent parents.");
    }

    if (parent.kind !== "main" && parent.kind !== "branch") {
      throw new Error(`Subagent parent session ${input.parentSessionId} must be a main or branch session.`);
    }
  }

  private async resolveProfile(input: CreateSubagentSessionInput, agentKey: string): Promise<{
    profile: SubagentProfileSnapshot;
  }> {
    if (input.toolGroups !== undefined) {
      const toolGroups = normalizeSubagentToolGroups(input.toolGroups);
      if (toolGroups.length === 0) {
        throw new Error("Ad-hoc subagent toolGroups must contain at least one group.");
      }
      return {profile: buildAdHocSubagentProfileSnapshot(toolGroups)};
    }

    const explicitProfile = input.profile === undefined ? undefined : requireTrimmed("profile", input.profile);
    const slug = normalizeSubagentProfileSlug(explicitProfile ?? DEFAULT_SUBAGENT_PROFILE);
    const profile = await this.profiles.getProfile({slug, agentKey});
    if (!profile) {
      throw new Error(`Subagent profile ${slug} was not found or is disabled.`);
    }
    return {profile: buildSubagentProfileSnapshot(profile)};
  }

  private async createSessionAndThread(
    session: CreateSessionInput,
    thread: CreateThreadInput,
    runtimeConfig: SubagentRuntimeConfig | undefined,
  ): Promise<{session: SessionRecord; thread: ThreadRecord}> {
    if (
      this.pool
      && this.sessions instanceof PostgresSessionStore
      && this.threads instanceof PostgresThreadRuntimeStore
    ) {
      return createSessionWithInitialThread({
        pool: this.pool,
        sessionStore: this.sessions,
        threadStore: this.threads,
        session,
        thread,
        runtimeConfig,
      });
    }

    const createdSession = await this.sessions.createSession(session);
    const createdThread = await this.threads.createThread(thread);
    if (runtimeConfig) {
      await this.sessions.updateSessionRuntimeConfig({
        sessionId: createdSession.id,
        ...runtimeConfig,
      });
    }
    return {
      session: createdSession,
      thread: createdThread,
    };
  }

  private async attachEnvironment(input: {
    session: Pick<SessionRecord, "id" | "agentKey">;
    environmentId: string;
    ownerSessionId: string;
    credentialPolicy: ExecutionCredentialPolicy;
    skillPolicy: ExecutionSkillPolicy;
    toolPolicy: ExecutionToolPolicy;
  }): Promise<CreateDisposableSessionEnvironmentResult> {
    if (!this.environments) {
      throw new Error("Subagent isolated execution requires an execution environment service.");
    }
    return this.environments.attachReadySessionToDisposableEnvironment({
      session: input.session,
      environmentId: input.environmentId,
      ownerSessionId: input.ownerSessionId,
      alias: "self",
      isDefault: true,
      credentialPolicy: input.credentialPolicy,
      skillPolicy: input.skillPolicy,
      toolPolicy: input.toolPolicy,
    });
  }

  private async bindParentSubagent(parentSessionId: string, subagentSessionId: string): Promise<void> {
    await this.a2aBindings.bindSession({
      senderSessionId: parentSessionId,
      recipientSessionId: subagentSessionId,
    });
    await this.a2aBindings.bindSession({
      senderSessionId: subagentSessionId,
      recipientSessionId: parentSessionId,
    });
  }

  private async enqueueHandoff(input: {
    threadId: string;
    task: string;
    context?: string;
    identityId?: string;
    parentSessionId: string;
    role: string;
    deliveryMode: "queue" | "wake";
  }): Promise<void> {
    const payload = {
      message: stringToUserMessage(renderSubagentHandoff(input.task, input.context)),
      source: SUBAGENT_INPUT_SOURCE,
      externalMessageId: `subagent-handoff:${input.threadId}`,
      identityId: input.identityId,
      metadata: {
        subagent: {
          version: 1,
          parentSessionId: input.parentSessionId,
          role: input.role,
        },
      },
    };
    if (this.coordinator) {
      await this.coordinator.submitInput(input.threadId, payload, input.deliveryMode);
      return;
    }

    await this.threads.enqueueInput(input.threadId, payload, input.deliveryMode);
  }

  private async deleteCreatedSubagentSession(sessionId: string, threadId: string): Promise<void> {
    if (!this.pool) {
      return;
    }

    const tables = buildSessionTableNames();
    await this.pool.query(
      `DELETE FROM ${tables.sessions} WHERE id = $1 AND kind = 'subagent' AND current_thread_id = $2`,
      [sessionId, threadId],
    );
  }
}
