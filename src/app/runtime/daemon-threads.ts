import {randomUUID} from "node:crypto";

import {type MediaDescriptor, relocateMediaDescriptor} from "../../domain/channels/index.js";
import {createDefaultIdentityInput, type IdentityRecord} from "../../domain/identity/index.js";
import type {
    CreateBranchSessionRequestPayload,
    ResetSessionRequestPayload,
    ResolveMainSessionThreadRequestPayload,
} from "../../domain/threads/requests/index.js";
import {type ThreadRecord} from "../../domain/threads/runtime/index.js";
import type {JsonValue} from "../../kernel/agent/types.js";
import {TELEGRAM_SOURCE} from "../../integrations/channels/telegram/config.js";
import {resolvePandaAgentMediaDir} from "./data-dir.js";
import type {PandaDaemonContext} from "./daemon-bootstrap.js";
import {requireIdentityId, trimNonEmptyString} from "./daemon-shared.js";

export interface DaemonThreadHelpers {
  ensureIdentity(identityId: string): Promise<IdentityRecord>;
  createBranchSession(input: {
    identity: IdentityRecord;
    sessionId?: string;
    agentKey?: string;
    model?: string;
    thinking?: CreateBranchSessionRequestPayload["thinking"];
    inferenceProjection?: CreateBranchSessionRequestPayload["inferenceProjection"];
    context?: Record<string, unknown>;
  }): Promise<ThreadRecord>;
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
    context?: Record<string, unknown>;
    metadata?: JsonValue;
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
  handleResetSession(payload: ResetSessionRequestPayload): Promise<Record<string, unknown>>;
}

async function listIdentityPairings(runtime: PandaDaemonContext["runtime"], identityId: string) {
  const store = runtime.agentStore as typeof runtime.agentStore & {
    listIdentityPairings?: (identityId: string) => Promise<readonly {agentKey: string}[]>;
  };
  return store.listIdentityPairings ? await store.listIdentityPairings(identityId) : [];
}

export function createDaemonThreadHelpers(
  context: PandaDaemonContext,
): DaemonThreadHelpers {
  const ensureIdentity = async (identityId: string): Promise<IdentityRecord> => {
    return identityId === createDefaultIdentityInput().id
      ? context.runtime.identityStore.ensureIdentity(createDefaultIdentityInput())
      : context.runtime.identityStore.getIdentity(identityId);
  };

  const resolveAccessibleAgentKey = async (
    identity: IdentityRecord,
    explicitAgentKey?: string,
  ): Promise<string> => {
    const pairings = await listIdentityPairings(context.runtime, identity.id);
    const requestedAgentKey = trimNonEmptyString(explicitAgentKey);
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

  const createInitialSessionThread = async (input: {
    sessionId: string;
    agentKey?: string;
    id?: string;
    model?: string;
    thinking?: CreateBranchSessionRequestPayload["thinking"];
    inferenceProjection?: CreateBranchSessionRequestPayload["inferenceProjection"];
    context?: Record<string, unknown>;
  }): Promise<ThreadRecord> => {
    return context.runtime.store.createThread({
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId,
      context: {
        ...context.fallbackContext,
        ...(input.agentKey
          ? {
            agentKey: input.agentKey,
            sessionId: input.sessionId,
          }
          : {}),
        ...(input.context ?? {}),
      },
      model: input.model ?? context.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
    });
  };

  const ensureMainSession = async (
    agentKey: string,
    identity?: IdentityRecord,
  ) => {
    const existing = await context.runtime.sessionStore.getMainSession(agentKey);
    if (existing) {
      return existing;
    }

    const sessionId = randomUUID();
    const threadId = randomUUID();
    const session = await context.runtime.sessionStore.createSession({
      id: sessionId,
      agentKey,
      kind: "main",
      currentThreadId: threadId,
      createdByIdentityId: identity?.id,
    });
    await createInitialSessionThread({
      sessionId,
      agentKey,
      id: threadId,
    });
    return session;
  };

  const resolveCurrentThread = async (sessionId: string): Promise<ThreadRecord> => {
    const session = await context.runtime.sessionStore.getSession(sessionId);
    return context.runtime.store.getThread(session.currentThreadId);
  };

  const createBranchSession = async (input: {
    identity: IdentityRecord;
    sessionId?: string;
    agentKey?: string;
    model?: string;
    thinking?: CreateBranchSessionRequestPayload["thinking"];
    inferenceProjection?: CreateBranchSessionRequestPayload["inferenceProjection"];
    context?: Record<string, unknown>;
  }): Promise<ThreadRecord> => {
    const agentKey = await resolveAccessibleAgentKey(input.identity, input.agentKey);
    const sessionId = input.sessionId ?? randomUUID();
    const threadId = randomUUID();
    await context.runtime.sessionStore.createSession({
      id: sessionId,
      agentKey,
      kind: "branch",
      currentThreadId: threadId,
      createdByIdentityId: input.identity.id,
    });
    return createInitialSessionThread({
      sessionId,
      agentKey,
      id: threadId,
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
      context: input.context,
    });
  };

  const relocateThreadMedia = async (
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]> => {
    if (media.length === 0) {
      return media;
    }

    const session = await context.runtime.sessionStore.getSession(thread.sessionId);
    const rootDir = resolvePandaAgentMediaDir(session.agentKey);
    return Promise.all(media.map((descriptor) => relocateMediaDescriptor(descriptor, {rootDir})));
  };

  const openMainSession = async (
    input: ResolveMainSessionThreadRequestPayload,
  ): Promise<ThreadRecord> => {
    const identity = await ensureIdentity(requireIdentityId(input.identityId, "resolve_main_session_thread"));
    const agentKey = await resolveAccessibleAgentKey(identity, input.agentKey);
    const session = await ensureMainSession(agentKey, identity);
    return resolveCurrentThread(session.id);
  };

  const resolveOrCreateConversationThread = async (input: {
    identityId: string;
    source: string;
    connectorKey: string;
    externalConversationId: string;
    context?: Record<string, unknown>;
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

    const session = await ensureMainSession(pairings[0]!.agentKey, identity);
    await context.conversationBindings.bindConversation({
      source: input.source,
      connectorKey: input.connectorKey,
      externalConversationId: input.externalConversationId,
      sessionId: session.id,
      metadata: input.metadata,
    });
    return resolveCurrentThread(session.id);
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
    identity?: IdentityRecord;
    source: string;
    model?: string;
    thinking?: ResetSessionRequestPayload["thinking"];
    inferenceProjection?: ResetSessionRequestPayload["inferenceProjection"];
    context?: Record<string, unknown>;
  }): Promise<{thread: ThreadRecord; previousThreadId: string}> => {
    const session = await context.runtime.sessionStore.getSession(input.sessionId);
    const previousThread = await context.runtime.store.getThread(session.currentThreadId);
    await context.runtime.coordinator.abort(previousThread.id, `Reset requested from ${input.source}.`);
    await context.runtime.coordinator.waitForCurrentRun(previousThread.id);
    await context.runtime.bashJobService.cancelThreadJobs(previousThread.id);
    await context.runtime.store.discardPendingInputs(previousThread.id);

    const thread = await createInitialSessionThread({
      sessionId: session.id,
      agentKey: session.agentKey,
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
      context: input.context,
    });
    await context.runtime.sessionStore.updateCurrentThread({
      sessionId: session.id,
      currentThreadId: thread.id,
    });

    return {
      thread,
      previousThreadId: previousThread.id,
    };
  };

  const handleResetSession = async (
    payload: ResetSessionRequestPayload,
  ): Promise<Record<string, unknown>> => {
    if (payload.source === TELEGRAM_SOURCE && payload.connectorKey && payload.externalConversationId) {
      const binding = await context.conversationBindings.getConversationBinding({
        source: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
      });

      const identity = payload.identityId
        ? await ensureIdentity(requireIdentityId(payload.identityId, "reset_session"))
        : undefined;
      const sessionId = binding?.sessionId
        ?? (identity
          ? (await ensureMainSession(await resolveAccessibleAgentKey(identity, payload.agentKey), identity)).id
          : null);
      if (!sessionId) {
        throw new Error("Cannot reset an unbound conversation without a paired identity.");
      }

      const result = await resetSession({
        sessionId,
        identity,
        source: payload.source,
        model: payload.model,
        thinking: payload.thinking,
        inferenceProjection: payload.inferenceProjection,
        context: {source: TELEGRAM_SOURCE},
      });

      await context.conversationBindings.bindConversation({
        source: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        sessionId,
        metadata: payload.commandExternalMessageId
          ? {
            kind: "telegram_reset_receipt",
            commandExternalMessageId: payload.commandExternalMessageId,
          }
          : undefined,
      });
      await context.sessionRoutes.saveLastRoute({
        sessionId,
        identityId: identity?.id,
        route: {
          source: TELEGRAM_SOURCE,
          connectorKey: payload.connectorKey,
          externalConversationId: payload.externalConversationId,
          externalActorId: payload.externalActorId,
          externalMessageId: payload.commandExternalMessageId,
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
      session = await ensureMainSession(await resolveAccessibleAgentKey(identity, payload.agentKey), identity);
    }
    const result = await resetSession({
      sessionId: session.id,
      identity,
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
    relocateThreadMedia,
    openMainSession,
    resolveOrCreateConversationThread,
    queueSystemReply,
    handleResetSession,
  };
}
