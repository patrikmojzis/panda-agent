import {randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";

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
import type {SessionStore} from "../../domain/sessions/store.js";
import type {
  CreateSessionInput,
  SessionRecord,
  UpdateSessionRuntimeConfigInput,
} from "../../domain/sessions/types.js";
import type {SessionLifecycle} from "../../domain/sessions/lifecycle.js";
import type {SubagentProfileStore} from "../../domain/subagents/store.js";
import {
  buildAdHocSubagentProfileSnapshot,
  buildSubagentProfileSnapshot,
  buildSubagentSessionMetadata,
  readSubagentSessionMetadata,
  type SubagentSessionMetadata,
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
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {SessionArchivedError} from "../../domain/threads/runtime/store.js";
import {RetryableRuntimeRequestError} from "../../domain/threads/requests/errors.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {CreateThreadInput, InferenceProjection, ThreadRecord} from "../../domain/threads/runtime/types.js";
import {trimToUndefined, uniqueTrimmedStrings} from "../../lib/strings.js";
import {renderSubagentHandoff} from "../../prompts/runtime/subagents.js";
import {
  InvalidDisposableEnvironmentAttachmentError,
  type CreateDisposableSessionEnvironmentResult,
} from "./execution-environment-service.js";

const SUBAGENT_INPUT_SOURCE = "subagent";
const DEFAULT_SUBAGENT_PROFILE = "workspace";

type SubagentRuntimeConfig = Omit<UpdateSessionRuntimeConfigInput, "sessionId">;

type SubagentSessionStore = Pick<
  SessionStore,
  | "deleteSubagentCreation"
  | "getSession"
  | "getSessionCreationOperation"
  | "recordSessionCreationOperation"
  | "updateSessionRuntimeConfig"
>;

type SubagentThreadStore = Pick<
  ThreadRuntimeStore,
  "enqueueSessionInput" | "findInput" | "getThread"
>;

type SubagentEnvironmentAttacher = {
  validateReadyDisposableEnvironment(input: {
    environmentId: string;
    agentKey: string;
    ownerSessionId: string;
  }): Promise<ExecutionEnvironmentRecord>;
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
  getSessionEnvironmentAttachment(input: {
    session: Pick<SessionRecord, "id" | "agentKey">;
    environmentId: string;
  }): Promise<CreateDisposableSessionEnvironmentResult | null>;
};

export interface CreateSubagentSessionInput {
  operationId?: string;
  replayAttempt?: boolean;
  agentKey: string;
  parentSessionId: string;
  task: string;
  context?: string;
  profile?: string;
  toolGroups?: readonly string[];
  execution?: SubagentExecutionMode;
  environmentId?: string;
  credentialAllowlist?: readonly string[];
  credentialRefAllowlist?: readonly string[];
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
  sessionLifecycle: Pick<SessionLifecycle, "create">;
  sessions: SubagentSessionStore;
  threads: SubagentThreadStore;
  profiles: SubagentProfileStore;
  environments?: SubagentEnvironmentAttacher;
  a2aBindings: {
    bindSession(input: BindA2ASessionInput): Promise<A2ASessionBindingRecord>;
  };
  commandCatalog?: Pick<CommandCatalog, "namesForToolGroups">;
  commandModules?: readonly CommandPolicyModule[];
  coordinator?: Pick<ThreadRuntimeCoordinator, "submitSessionInput">;
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
  const credentialRefs = uniqueTrimmedStrings(input.credentialRefAllowlist ?? []);
  return {
    mode: "allowlist",
    envKeys: uniqueTrimmedStrings(input.credentialAllowlist ?? []),
    ...(credentialRefs.length > 0 ? {credentialRefs} : {}),
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
  private readonly sessionLifecycle: Pick<SessionLifecycle, "create">;
  private readonly sessions: SubagentSessionStore;
  private readonly threads: SubagentThreadStore;
  private readonly profiles: SubagentProfileStore;
  private readonly environments?: SubagentEnvironmentAttacher;
  private readonly a2aBindings: SubagentSessionServiceOptions["a2aBindings"];
  private readonly commandCatalog?: Pick<CommandCatalog, "namesForToolGroups">;
  private readonly commandModules: readonly CommandPolicyModule[];
  private readonly coordinator?: Pick<ThreadRuntimeCoordinator, "submitSessionInput">;

  constructor(options: SubagentSessionServiceOptions) {
    this.sessionLifecycle = options.sessionLifecycle;
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
    const task = requireTrimmed("task", input.task);
    const execution = input.execution ?? "agent_workspace";
    const environmentId = trimToUndefined(input.environmentId);
    if (execution === "isolated_environment" && !environmentId) {
      throw new Error("Isolated subagent execution requires environmentId.");
    }
    if (execution === "agent_workspace" && environmentId) {
      throw new Error("agent_workspace subagent execution must not set environmentId.");
    }

    const sessionId = trimToUndefined(input.sessionId) ?? randomUUID();
    const threadId = trimToUndefined(input.threadId) ?? randomUUID();
    const expected = {
      agentKey,
      parentSessionId,
      task,
      execution,
      environmentId,
      sessionId,
      threadId,
    };
    if (input.replayAttempt) {
      const replay = await this.readCreationReplay(input, expected);
      if (replay) {
        return this.completeCreationEffects(input, replay, replay.metadata, false);
      }
    }

    await this.assertValidParentSession({agentKey, parentSessionId});

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
        ...(input.inferenceProjection ? {inferenceProjection: input.inferenceProjection} : {}),
        credentialPolicy,
        skillPolicy,
        toolPolicy,
      },
    });
    const metadataSnapshot = readSubagentSessionMetadata(metadata);
    if (!metadataSnapshot) {
      throw new Error("Subagent creation metadata could not be read after serialization.");
    }

    if (execution === "isolated_environment") {
      if (!this.environments) {
        throw new Error("Subagent isolated execution requires an execution environment service.");
      }
      await this.environments.validateReadyDisposableEnvironment({
        environmentId: environmentId ?? "",
        agentKey,
        ownerSessionId: parentSessionId,
      });
    }

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
    }, runtimeConfig, input.operationId && input.createdByIdentityId
      ? {
          operationId: input.operationId,
          identityId: input.createdByIdentityId,
          kind: "subagent",
        }
      : undefined, parentSessionId);

    return this.completeCreationEffects(input, created, metadataSnapshot, created.createdNew);
  }

  private async readCreationReplay(
    input: CreateSubagentSessionInput,
    expected: {
      agentKey: string;
      parentSessionId: string;
      task: string;
      execution: SubagentExecutionMode;
      environmentId?: string;
      sessionId: string;
      threadId: string;
    },
  ): Promise<{session: SessionRecord; thread: ThreadRecord; metadata: SubagentSessionMetadata} | null> {
    if (!input.operationId) return null;
    let receipt;
    try {
      receipt = await this.sessions.getSessionCreationOperation(input.operationId);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Subagent creation operation ${input.operationId} could not read its receipt.`,
        {cause: error},
      );
    }
    if (!receipt) return null;
    if (
      receipt.identityId !== input.createdByIdentityId
      || receipt.agentKey !== expected.agentKey
      || receipt.kind !== "subagent"
      || receipt.sessionId !== expected.sessionId
      || receipt.threadId !== expected.threadId
    ) {
      throw new Error(`Subagent session operation ${input.operationId} conflicts with another target.`);
    }
    let session: SessionRecord;
    try {
      session = await this.sessions.getSession(expected.sessionId);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Subagent creation operation ${input.operationId} could not read its session.`,
        {cause: error},
      );
    }
    const metadata = readSubagentSessionMetadata(session.metadata);
    if (!metadata) {
      throw new Error(`Subagent session ${expected.sessionId} has no creation snapshot.`);
    }
    const requestedProfile = input.profile === undefined
      ? DEFAULT_SUBAGENT_PROFILE
      : normalizeSubagentProfileSlug(requireTrimmed("profile", input.profile));
    const requestedToolGroups = input.toolGroups === undefined
      ? undefined
      : normalizeSubagentToolGroups(input.toolGroups);
    const requestedModel = input.model === undefined ? undefined : resolveModel(input.model).model;
    const requestedThinking = input.thinking === undefined ? undefined : input.thinking ?? undefined;
    const creationMatches = session.agentKey === expected.agentKey
      && session.kind === "subagent"
      && metadata.parentSessionId === expected.parentSessionId
      && metadata.task === expected.task
      && (metadata.context ?? undefined) === trimToUndefined(input.context)
      && metadata.execution === expected.execution
      && (metadata.environmentId ?? undefined) === expected.environmentId
      && (requestedToolGroups
        ? metadata.profile.source === "ad_hoc" && isDeepStrictEqual(metadata.profile.toolGroups, requestedToolGroups)
        : metadata.profile.slug === requestedProfile)
      && (requestedModel === undefined
        || (metadata.resolved.model === requestedModel && metadata.resolved.modelSource === "spawn"))
      && (input.thinking === undefined || isDeepStrictEqual(metadata.resolved.thinking, requestedThinking))
      && isDeepStrictEqual(metadata.resolved.inferenceProjection, input.inferenceProjection)
      && isDeepStrictEqual(metadata.resolved.credentialPolicy, buildCredentialPolicy(input));
    if (!creationMatches) {
      throw new Error(`Subagent session ${expected.sessionId} already exists with different creation parameters.`);
    }
    let thread;
    try {
      thread = await this.threads.getThread(expected.threadId);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Subagent creation operation ${input.operationId} could not read its initial thread.`,
        {cause: error},
      );
    }
    if (thread.sessionId !== session.id) {
      throw new Error(`Subagent thread ${expected.threadId} belongs to another session.`);
    }
    return {session, thread, metadata};
  }

  private async completeCreationEffects(
    input: CreateSubagentSessionInput,
    created: {session: SessionRecord; thread: ThreadRecord},
    metadata: SubagentSessionMetadata,
    createdNew = false,
  ): Promise<CreateSubagentSessionResult> {
    try {
      if (!createdNew && input.operationId && await this.hasCommittedHandoff({
        inputId: input.operationId,
        initialThreadId: created.thread.id,
        sessionId: created.session.id,
      })) {
        const attached = metadata.execution === "isolated_environment"
          ? await this.environments?.getSessionEnvironmentAttachment({
              session: created.session,
              environmentId: metadata.environmentId ?? "",
            })
          : undefined;
        return {
          session: created.session,
          thread: created.thread,
          ...(attached ? {environment: attached.environment, binding: attached.binding} : {}),
        };
      }
      await this.assertValidParentSession({
        agentKey: created.session.agentKey,
        parentSessionId: metadata.parentSessionId,
      });
      const attached = metadata.execution === "isolated_environment"
        ? await this.attachEnvironment({
            session: created.session,
            environmentId: metadata.environmentId ?? "",
            ownerSessionId: metadata.parentSessionId,
            credentialPolicy: metadata.resolved.credentialPolicy,
            skillPolicy: metadata.resolved.skillPolicy,
            toolPolicy: metadata.resolved.toolPolicy,
          }, !createdNew)
        : undefined;
      await this.bindParentSubagent(metadata.parentSessionId, created.session.id);
      await this.enqueueHandoff({
        initialThreadId: created.thread.id,
        sessionId: created.session.id,
        task: metadata.task,
        context: metadata.context,
        identityId: created.session.createdByIdentityId,
        parentSessionId: metadata.parentSessionId,
        role: metadata.profile.slug,
        deliveryMode: input.deliveryMode ?? "wake",
        inputId: input.operationId,
      });
      return {
        session: created.session,
        thread: created.thread,
        ...(attached ? {environment: attached.environment, binding: attached.binding} : {}),
      };
    } catch (error) {
      if (
        error instanceof RetryableRuntimeRequestError
        || error instanceof SessionArchivedError
      ) throw error;
      if (input.operationId && error instanceof InvalidDisposableEnvironmentAttachmentError) {
        try {
          const deleted = await this.deleteCreatedSubagentSession(created.session.id, created.thread.id);
          if (!deleted) {
            throw new Error("The incomplete subagent anchor changed before compensation.");
          }
        } catch (cleanupError) {
          throw new RetryableRuntimeRequestError(
            `Subagent session ${created.session.id} has a terminal environment error but could not be compensated.`,
            {cause: cleanupError},
          );
        }
        // Attachment is the first dependent effect. A deterministic rejection
        // here means no A2A binding or handoff exists, so deleting the anchor
        // is the only convergent saga outcome; retrying can never create the
        // requested isolated session from this environment snapshot.
        throw error;
      }
      if (!input.operationId && createdNew) {
        try {
          await this.deleteCreatedSubagentSession(created.session.id, created.thread.id);
        } catch (cleanupError) {
          throw new RetryableRuntimeRequestError(
            `Subagent session ${created.session.id} failed and could not be cleaned up.`,
            {cause: cleanupError},
          );
        }
      }
      if (!input.operationId) throw error;
      // Session/thread creation is the durable anchor. Every remaining effect
      // uses an idempotent key, so retries converge without deleting a session
      // another process may already have observed.
      throw new RetryableRuntimeRequestError(
        `Subagent session ${created.session.id} was created but its dependent effects are incomplete.`,
        {cause: error},
      );
    }
  }

  private async assertValidParentSession(input: {agentKey: string; parentSessionId: string}): Promise<void> {
    let parent: SessionRecord;
    try {
      parent = await this.sessions.getSession(input.parentSessionId);
    } catch (error) {
      if (error instanceof Error && error.message === `Unknown session ${input.parentSessionId}`) {
        throw new Error(`Subagent parent session ${input.parentSessionId} was not found.`);
      }
      throw new RetryableRuntimeRequestError(
        `Subagent parent session ${input.parentSessionId} could not be read.`,
        {cause: error},
      );
    }

    if (parent.agentKey !== input.agentKey) {
      throw new Error(`Subagent session agent ${input.agentKey} must match parent session agent ${parent.agentKey}.`);
    }

    if (parent.archivedAt !== undefined) {
      throw new SessionArchivedError(input.parentSessionId);
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
    operation?: {
      operationId: string;
      identityId: string;
      kind: "subagent";
    },
    activeParentSessionId?: string,
  ): Promise<{session: SessionRecord; thread: ThreadRecord; createdNew: boolean}> {
    try {
      const created = await this.sessionLifecycle.create({
        session, thread, runtimeConfig, operation, activeParentSessionId,
      });
      return {...created, createdNew: true};
    } catch (error) {
      if (!operation) throw error;
      let existingSession: SessionRecord;
      try {
        existingSession = await this.sessions.getSession(session.id);
      } catch (readError) {
        if (readError instanceof Error && readError.message === `Unknown session ${session.id}`) {
          throw new RetryableRuntimeRequestError(
            `Subagent creation operation ${operation.operationId} did not reach a durable receipt.`,
            {cause: error},
          );
        }
        throw new RetryableRuntimeRequestError(
          `Subagent creation operation ${operation.operationId} could not read its session.`,
          {cause: readError},
        );
      }
      if (
        existingSession.agentKey !== session.agentKey
        || existingSession.kind !== "subagent"
        || !isDeepStrictEqual(existingSession.metadata, session.metadata)
      ) {
        throw new Error(`Subagent session ${session.id} already exists with different creation parameters.`);
      }
      let existingThread;
      try {
        existingThread = await this.threads.getThread(thread.id);
      } catch (readError) {
        throw new RetryableRuntimeRequestError(
          `Subagent creation operation ${operation.operationId} could not read its thread.`,
          {cause: readError},
        );
      }
      if (existingThread.sessionId !== session.id) {
        throw new Error(`Subagent thread ${thread.id} belongs to another session.`);
      }
      // Creation replay is validation, not a configuration mutation. A later
      // update_thread request owns the mutable runtime configuration.
      await this.sessions.recordSessionCreationOperation({
        ...operation,
        agentKey: existingSession.agentKey,
        sessionId: existingSession.id,
        threadId: existingThread.id,
      });
      return {session: existingSession, thread: existingThread, createdNew: false};
    }
  }

  private async attachEnvironment(input: {
    session: Pick<SessionRecord, "id" | "agentKey">;
    environmentId: string;
    ownerSessionId: string;
    credentialPolicy: ExecutionCredentialPolicy;
    skillPolicy: ExecutionSkillPolicy;
    toolPolicy: ExecutionToolPolicy;
  }, preserveExisting: boolean): Promise<CreateDisposableSessionEnvironmentResult> {
    if (!this.environments) {
      throw new Error("Subagent isolated execution requires an execution environment service.");
    }
    if (preserveExisting) {
      const existing = await this.environments.getSessionEnvironmentAttachment({
        session: input.session,
        environmentId: input.environmentId,
      });
      if (existing) {
        // The attachment is a completed creation effect. Replaying the spawn
        // snapshot must not roll back later operator-owned binding changes.
        return existing;
      }
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

  private async deleteCreatedSubagentSession(sessionId: string, threadId: string): Promise<boolean> {
    return this.sessions.deleteSubagentCreation(sessionId, threadId);
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
    initialThreadId: string;
    sessionId: string;
    task: string;
    context?: string;
    identityId?: string;
    parentSessionId: string;
    role: string;
    deliveryMode: "queue" | "wake";
    inputId?: string;
  }): Promise<void> {
    const externalMessageId = `subagent-handoff:${input.initialThreadId}`;
    const payload = {
      message: stringToUserMessage(renderSubagentHandoff(input.task, input.context)),
      source: SUBAGENT_INPUT_SOURCE,
      externalMessageId,
      identityId: input.identityId,
      metadata: {
        subagent: {
          version: 1,
          parentSessionId: input.parentSessionId,
          role: input.role,
        },
      },
    };
    const enqueueOptions = input.inputId ? {inputId: input.inputId} : undefined;
    if (this.coordinator) {
      await this.coordinator.submitSessionInput(input.sessionId, payload, input.deliveryMode, enqueueOptions);
      return;
    }

    await this.threads.enqueueSessionInput(input.sessionId, payload, input.deliveryMode, enqueueOptions);
  }

  private async hasCommittedHandoff(input: {
    inputId: string;
    initialThreadId: string;
    sessionId: string;
  }): Promise<boolean> {
    const existing = await this.threads.findInput(input.inputId);
    if (!existing) return false;
    const existingThread = await this.threads.getThread(existing.threadId);
    if (
      existingThread.sessionId !== input.sessionId
      || existing.source !== SUBAGENT_INPUT_SOURCE
      || existing.externalMessageId !== `subagent-handoff:${input.initialThreadId}`
    ) {
      throw new Error(`Subagent handoff input ${input.inputId} conflicts with another operation.`);
    }
    return true;
  }

}
