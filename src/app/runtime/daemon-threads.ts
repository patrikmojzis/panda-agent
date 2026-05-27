import {randomUUID} from "node:crypto";

import {relocateMediaDescriptor} from "../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../domain/channels/types.js";
import type {OutboundDeliveryInput} from "../../domain/channels/deliveries/types.js";
import type {IdentityRecord} from "../../domain/identity/types.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import {createSessionWithInitialThread, resetSessionCurrentThread} from "../../domain/sessions/lifecycle.js";
import type {SessionRecord, UpdateSessionRuntimeConfigInput} from "../../domain/sessions/types.js";
import {resolveCurrentSessionThread} from "../../domain/sessions/current-thread.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {BindConversationInput, ConversationBinding, ConversationLookup} from "../../domain/sessions/conversations/types.js";
import type {SessionRouteInput} from "../../domain/sessions/routes/types.js";
import type {
  CreateBranchSessionRequestPayload,
  ResetSessionRequestPayload,
  ResetSessionResult,
  ResolveMainSessionThreadRequestPayload,
} from "../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import type {ThreadRecord} from "../../domain/threads/runtime/types.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {JsonValue} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";
import {resolveAgentMediaDir} from "./data-dir.js";
import {requireIdentityId} from "./daemon-shared.js";
import {
  createDaemonSubagentSessionCreator,
  type DaemonSubagentSessionContext,
  type DaemonCreateSubagentSessionInput,
} from "./daemon-subagent-sessions.js";
import type {CreateSubagentSessionResult} from "./subagent-session-service.js";

export interface DaemonThreadHelperContext {
  fallbackContext: {cwd: string};
  runtime: {
    pool?: PgPoolLike;
    agentStore: {
      getAgent(agentKey: string): Promise<unknown>;
      listIdentityPairings(identityId: string): Promise<readonly {agentKey: string}[]>;
    };
    backgroundJobService: {
      cancelThreadJobs(threadId: string): Promise<void>;
    };
    coordinator: Pick<ThreadRuntimeCoordinator, "abort" | "waitForCurrentRun">;
    identityStore: Pick<IdentityStore, "getIdentity">;
    sessionStore: Pick<SessionStore, "createSession" | "getMainSession" | "getSession" | "updateCurrentThread" | "updateSessionRuntimeConfig">;
    store: Pick<ThreadRuntimeStore, "createThread" | "discardPendingInputs" | "getThread">;
    subagentSessions: DaemonSubagentSessionContext["subagentSessions"];
  };
  conversationBindings: {
    bindConversation(input: BindConversationInput): Promise<unknown>;
    getConversationBinding(input: ConversationLookup): Promise<ConversationBinding | null>;
  };
  outboundDeliveries: {
    enqueueDelivery(input: OutboundDeliveryInput): Promise<unknown>;
  };
  sessionRoutes: {
    saveLastRoute(input: SessionRouteInput): Promise<unknown>;
  };
}

export interface DaemonThreadHelpers {
  ensureIdentity(identityId: string): Promise<IdentityRecord>;
  createBranchSession(input: {
    identity: IdentityRecord;
    sessionId?: string;
    threadId?: string;
    agentKey?: string;
    model?: string;
    thinking?: CreateBranchSessionRequestPayload["thinking"];
    inferenceProjection?: CreateBranchSessionRequestPayload["inferenceProjection"];
  }): Promise<ThreadRecord>;
  createSubagentSession(input: DaemonCreateSubagentSessionInput): Promise<CreateSubagentSessionResult>;
  relocateThreadMedia(
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]>;
  openMainSession(input: ResolveMainSessionThreadRequestPayload): Promise<ThreadRecord>;
  resolveOrCreateConversationThread(input: {
    identityId: string;
    source: string;
    connectorKey: string;
    externalConversationId: string;
    metadata?: JsonValue;
  }): Promise<ThreadRecord | null>;
  resolveBoundConversationThread(input: {
    source: string;
    connectorKey: string;
    externalConversationId: string;
  }): Promise<ThreadRecord | null>;
  queueSystemReply(input: {
    channel: string;
    connectorKey: string;
    externalConversationId: string;
    externalActorId?: string;
    text: string;
    replyToMessageId?: string;
    threadId?: string;
  }): Promise<void>;
  handleResetSession(payload: ResetSessionRequestPayload): Promise<ResetSessionResult>;
}

function isChannelBoundReset(
  payload: ResetSessionRequestPayload,
): payload is ResetSessionRequestPayload & {connectorKey: string; externalConversationId: string} {
  return payload.source !== "operator" && Boolean(payload.connectorKey && payload.externalConversationId);
}

export function createDaemonThreadHelpers(
  context: DaemonThreadHelperContext,
): DaemonThreadHelpers {
  const ensureIdentity = async (identityId: string): Promise<IdentityRecord> => {
    return context.runtime.identityStore.getIdentity(identityId);
  };

  const resolveAccessibleAgentKey = async (
    identity: IdentityRecord,
    explicitAgentKey?: string,
  ): Promise<string> => {
    const pairings = await context.runtime.agentStore.listIdentityPairings(identity.id);
    const requestedAgentKey = trimToUndefined(explicitAgentKey);
    if (requestedAgentKey) {
      await context.runtime.agentStore.getAgent(requestedAgentKey);
      if (!pairings.some((pairing) => pairing.agentKey === requestedAgentKey)) {
        throw new Error(`Identity ${identity.handle} is not paired to agent ${requestedAgentKey}.`);
      }

      return requestedAgentKey;
    }

    if (pairings.length === 1) {
      return pairings[0]!.agentKey;
    }

    if (pairings.length === 0) {
      throw new Error(`Identity ${identity.handle} is not paired to any agents.`);
    }

    throw new Error(`Identity ${identity.handle} is paired to multiple agents. Pick one explicitly.`);
  };

  const buildInitialSessionThreadInput = (input: {
    sessionId: string;
    id?: string;
  }) => {
    return {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
    };
  };

  const buildRuntimeConfigPatch = (input: {
    model?: string;
    thinking?: CreateBranchSessionRequestPayload["thinking"];
    inferenceProjection?: CreateBranchSessionRequestPayload["inferenceProjection"];
  }): Omit<UpdateSessionRuntimeConfigInput, "sessionId"> | undefined => {
    const patch = {
      ...(input.model !== undefined ? {model: input.model} : {}),
      ...(input.thinking !== undefined ? {thinking: input.thinking} : {}),
      ...(input.inferenceProjection !== undefined ? {inferenceProjection: input.inferenceProjection} : {}),
    } satisfies Omit<UpdateSessionRuntimeConfigInput, "sessionId">;
    return Object.keys(patch).length > 0 ? patch : undefined;
  };

  const updateSessionRuntimeConfig = async (
    sessionId: string,
    patch: Omit<UpdateSessionRuntimeConfigInput, "sessionId"> | undefined,
  ): Promise<void> => {
    if (!patch) {
      return;
    }
    await context.runtime.sessionStore.updateSessionRuntimeConfig({
      sessionId,
      ...patch,
    });
  };

  const ensureMainSession = async (
    agentKey: string,
    identity?: IdentityRecord,
    initialThread?: {
      model?: string;
      thinking?: ResolveMainSessionThreadRequestPayload["thinking"];
      inferenceProjection?: ResolveMainSessionThreadRequestPayload["inferenceProjection"];
    },
  ): Promise<{created: boolean; session: SessionRecord}> => {
    const existing = await context.runtime.sessionStore.getMainSession(agentKey);
    if (existing) {
      return {
        created: false,
        session: existing,
      };
    }

    const sessionId = randomUUID();
    const threadId = randomUUID();
    if (
      context.runtime.pool
      && context.runtime.sessionStore instanceof PostgresSessionStore
      && context.runtime.store instanceof PostgresThreadRuntimeStore
    ) {
      const created = await createSessionWithInitialThread({
        pool: context.runtime.pool,
        sessionStore: context.runtime.sessionStore,
        threadStore: context.runtime.store,
        session: {
          id: sessionId,
          agentKey,
          kind: "main",
          currentThreadId: threadId,
          createdByIdentityId: identity?.id,
        },
        thread: buildInitialSessionThreadInput({
          sessionId,
          id: threadId,
        }),
        runtimeConfig: buildRuntimeConfigPatch({
          model: initialThread?.model,
          thinking: initialThread?.thinking,
          inferenceProjection: initialThread?.inferenceProjection,
        }),
      });
      return {
        created: true,
        session: created.session,
      };
    }

    const session = await context.runtime.sessionStore.createSession({
      id: sessionId,
      agentKey,
      kind: "main",
      currentThreadId: threadId,
      createdByIdentityId: identity?.id,
    });
    await context.runtime.store.createThread(buildInitialSessionThreadInput({
      sessionId,
      id: threadId,
    }));
    await updateSessionRuntimeConfig(sessionId, buildRuntimeConfigPatch({
      model: initialThread?.model,
      thinking: initialThread?.thinking,
      inferenceProjection: initialThread?.inferenceProjection,
    }));
    return {
      created: true,
      session,
    };
  };

  const resolveCurrentThread = async (sessionId: string): Promise<ThreadRecord> => {
    const {threadId} = await resolveCurrentSessionThread(context.runtime.sessionStore, sessionId);
    return context.runtime.store.getThread(threadId);
  };

  const createBranchSession = async (input: {
    identity: IdentityRecord;
    sessionId?: string;
    agentKey?: string;
    model?: string;
    thinking?: CreateBranchSessionRequestPayload["thinking"];
    inferenceProjection?: CreateBranchSessionRequestPayload["inferenceProjection"];
  }): Promise<ThreadRecord> => {
    const agentKey = await resolveAccessibleAgentKey(input.identity, input.agentKey);
    const sessionId = input.sessionId ?? randomUUID();
    const threadId = randomUUID();
    const threadInput = buildInitialSessionThreadInput({
      sessionId,
      id: threadId,
    });
    const runtimeConfig = buildRuntimeConfigPatch(input);
    if (
      context.runtime.pool
      && context.runtime.sessionStore instanceof PostgresSessionStore
      && context.runtime.store instanceof PostgresThreadRuntimeStore
    ) {
      const created = await createSessionWithInitialThread({
        pool: context.runtime.pool,
        sessionStore: context.runtime.sessionStore,
        threadStore: context.runtime.store,
        session: {
          id: sessionId,
          agentKey,
          kind: "branch",
          currentThreadId: threadId,
          createdByIdentityId: input.identity.id,
        },
        thread: threadInput,
        runtimeConfig,
      });
      return created.thread;
    }

    await context.runtime.sessionStore.createSession({
      id: sessionId,
      agentKey,
      kind: "branch",
      currentThreadId: threadId,
      createdByIdentityId: input.identity.id,
    });
    const thread = await context.runtime.store.createThread(threadInput);
    await updateSessionRuntimeConfig(sessionId, runtimeConfig);
    return thread;
  };

  const createSubagentSession = createDaemonSubagentSessionCreator({
    resolveAccessibleAgentKey,
    subagentSessions: context.runtime.subagentSessions,
  });

  const relocateThreadMedia = async (
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]> => {
    if (media.length === 0) {
      return media;
    }

    const session = await context.runtime.sessionStore.getSession(thread.sessionId);
    const rootDir = resolveAgentMediaDir(session.agentKey);
    return Promise.all(media.map((descriptor) => relocateMediaDescriptor(descriptor, {rootDir})));
  };

  const openMainSession = async (
    input: ResolveMainSessionThreadRequestPayload,
  ): Promise<ThreadRecord> => {
    const identity = await ensureIdentity(requireIdentityId(input.identityId, "resolve_main_session_thread"));
    const agentKey = await resolveAccessibleAgentKey(identity, input.agentKey);
    const {created, session} = await ensureMainSession(agentKey, identity, {
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
    });
    const runtimeConfig = buildRuntimeConfigPatch(input);
    if (!created) {
      await updateSessionRuntimeConfig(session.id, runtimeConfig);
    }
    return resolveCurrentThread(session.id);
  };

  const resolveOrCreateConversationThread = async (input: {
    identityId: string;
    source: string;
    connectorKey: string;
    externalConversationId: string;
    metadata?: JsonValue;
  }): Promise<ThreadRecord | null> => {
    const existing = await context.conversationBindings.getConversationBinding({
      source: input.source,
      connectorKey: input.connectorKey,
      externalConversationId: input.externalConversationId,
    });
    if (existing) {
      return resolveCurrentThread(existing.sessionId);
    }

    const identity = await ensureIdentity(input.identityId);
    const pairings = await context.runtime.agentStore.listIdentityPairings(identity.id);
    if (pairings.length !== 1) {
      return null;
    }

    const {session} = await ensureMainSession(pairings[0]!.agentKey, identity);
    await context.conversationBindings.bindConversation({
      source: input.source,
      connectorKey: input.connectorKey,
      externalConversationId: input.externalConversationId,
      sessionId: session.id,
      metadata: input.metadata,
    });
    return resolveCurrentThread(session.id);
  };

  const resolveBoundConversationThread = async (input: {
    source: string;
    connectorKey: string;
    externalConversationId: string;
  }): Promise<ThreadRecord | null> => {
    const existing = await context.conversationBindings.getConversationBinding({
      source: input.source,
      connectorKey: input.connectorKey,
      externalConversationId: input.externalConversationId,
    });
    if (!existing) {
      return null;
    }

    return resolveCurrentThread(existing.sessionId);
  };

  const queueSystemReply = async (input: {
    channel: string;
    connectorKey: string;
    externalConversationId: string;
    externalActorId?: string;
    text: string;
    replyToMessageId?: string;
    threadId?: string;
  }): Promise<void> => {
    await context.outboundDeliveries.enqueueDelivery({
      threadId: input.threadId,
      channel: input.channel,
      target: {
        source: input.channel,
        connectorKey: input.connectorKey,
        externalConversationId: input.externalConversationId,
        externalActorId: input.externalActorId,
        replyToMessageId: input.replyToMessageId,
      },
      items: [{
        type: "text",
        text: input.text,
      }],
    });
  };

  const resetSession = async (input: {
    sessionId: string;
    source: string;
    model?: string;
    thinking?: ResetSessionRequestPayload["thinking"];
    inferenceProjection?: ResetSessionRequestPayload["inferenceProjection"];
  }): Promise<{thread: ThreadRecord; previousThreadId: string}> => {
    const {session, threadId} = await resolveCurrentSessionThread(context.runtime.sessionStore, input.sessionId);
    const previousThread = await context.runtime.store.getThread(threadId);
    await context.runtime.coordinator.abort(previousThread.id, `Reset requested from ${input.source}.`);
    await context.runtime.coordinator.waitForCurrentRun(previousThread.id);
    await context.runtime.backgroundJobService.cancelThreadJobs(previousThread.id);
    await context.runtime.store.discardPendingInputs(previousThread.id);

    const nextThread = buildInitialSessionThreadInput({
      sessionId: session.id,
    });
    const runtimeConfig = buildRuntimeConfigPatch(input);
    const thread = (
      context.runtime.pool
      && context.runtime.sessionStore instanceof PostgresSessionStore
      && context.runtime.store instanceof PostgresThreadRuntimeStore
    )
      ? await resetSessionCurrentThread({
        pool: context.runtime.pool,
        sessionStore: context.runtime.sessionStore,
        threadStore: context.runtime.store,
        thread: nextThread,
        session: {
          sessionId: session.id,
          currentThreadId: nextThread.id,
        },
        runtimeConfig,
      })
      : await context.runtime.store.createThread(nextThread);
    if (!(context.runtime.pool
      && context.runtime.sessionStore instanceof PostgresSessionStore
      && context.runtime.store instanceof PostgresThreadRuntimeStore)
    ) {
      await updateSessionRuntimeConfig(session.id, runtimeConfig);
      await context.runtime.sessionStore.updateCurrentThread({
        sessionId: session.id,
        currentThreadId: nextThread.id,
      });
    }

    return {
      thread,
      previousThreadId: previousThread.id,
    };
  };

  const handleResetSession = async (
    payload: ResetSessionRequestPayload,
  ): Promise<ResetSessionResult> => {
    if (isChannelBoundReset(payload)) {
      const externalMessageId = payload.externalMessageId ?? payload.commandExternalMessageId;
      const binding = await context.conversationBindings.getConversationBinding({
        source: payload.source,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
      });

      const identity = payload.identityId
        ? await ensureIdentity(requireIdentityId(payload.identityId, "reset_session"))
        : undefined;
      const sessionId = binding?.sessionId
        ?? (identity
          ? (await ensureMainSession(await resolveAccessibleAgentKey(identity, payload.agentKey), identity)).session.id
          : null);
      if (!sessionId) {
        throw new Error("Cannot reset an unbound conversation without a paired identity.");
      }

      const result = await resetSession({
        sessionId,
        source: payload.source,
        model: payload.model,
        thinking: payload.thinking,
        inferenceProjection: payload.inferenceProjection,
      });

      await context.conversationBindings.bindConversation({
        source: payload.source,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        sessionId,
        metadata: externalMessageId
          ? {
            kind: "channel_reset_receipt",
            externalMessageId,
          }
          : undefined,
      });
      await context.sessionRoutes.saveLastRoute({
        sessionId,
        identityId: identity?.id,
        route: {
          source: payload.source,
          connectorKey: payload.connectorKey,
          externalConversationId: payload.externalConversationId,
          externalActorId: payload.externalActorId,
          externalMessageId,
          capturedAt: Date.now(),
        },
      });

      return {
        threadId: result.thread.id,
        previousThreadId: result.previousThreadId,
        sessionId,
      };
    }

    if (payload.source === "operator") {
      const session = payload.sessionId
        ? await context.runtime.sessionStore.getSession(payload.sessionId)
        : payload.threadId
          ? await context.runtime.sessionStore.getSession((await context.runtime.store.getThread(payload.threadId)).sessionId)
          : null;
      if (!session) {
        throw new Error("Operator reset requires sessionId or threadId.");
      }

      const result = await resetSession({
        sessionId: session.id,
        source: payload.source,
        model: payload.model,
        thinking: payload.thinking,
        inferenceProjection: payload.inferenceProjection,
      });

      return {
        threadId: result.thread.id,
        previousThreadId: result.previousThreadId,
        sessionId: session.id,
      };
    }

    const identity = await ensureIdentity(requireIdentityId(payload.identityId, "reset_session"));
    let session;
    if (payload.threadId) {
      session = await context.runtime.sessionStore.getSession((await context.runtime.store.getThread(payload.threadId)).sessionId);
      await resolveAccessibleAgentKey(identity, session.agentKey);
    } else if (payload.sessionId) {
      session = await context.runtime.sessionStore.getSession(payload.sessionId);
      await resolveAccessibleAgentKey(identity, session.agentKey);
    } else {
      session = (await ensureMainSession(await resolveAccessibleAgentKey(identity, payload.agentKey), identity)).session;
    }
    const result = await resetSession({
      sessionId: session.id,
      source: payload.source,
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
    });

    return {
      threadId: result.thread.id,
      previousThreadId: result.previousThreadId,
      sessionId: session.id,
    };
  };

  return {
    ensureIdentity,
    createBranchSession,
    createSubagentSession,
    relocateThreadMedia,
    openMainSession,
    resolveOrCreateConversationThread,
    resolveBoundConversationThread,
    queueSystemReply,
    handleResetSession,
  };
}
