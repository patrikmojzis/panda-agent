import {randomUUID} from "node:crypto";

import {type MediaDescriptor, relocateMediaDescriptor,} from "../../domain/channels/index.js";
import {createDefaultIdentityInput, type IdentityRecord,} from "../../domain/identity/index.js";
import type {
    CreateThreadRequestPayload,
    ResetHomeThreadRequestPayload,
    ResolveHomeThreadRequestPayload,
    SwitchHomeAgentRequestPayload,
} from "../../domain/threads/requests/index.js";
import {isMissingThreadError, type ThreadRecord,} from "../../domain/threads/runtime/index.js";
import type {JsonValue} from "../../kernel/agent/types.js";
import {TELEGRAM_SOURCE} from "../../integrations/channels/telegram/config.js";
import {resolvePandaAgentMediaDir} from "./data-dir.js";
import type {PandaDaemonContext} from "./daemon-bootstrap.js";
import {
    buildHomeAgentMismatchMessage,
    buildMissingDefaultAgentMessage,
    buildMissingSwitchHomeAgentKeyMessage,
} from "./daemon-copy.js";
import {requireIdentityId, resolveImplicitHomeThreadReplacementAgent, trimNonEmptyString,} from "./daemon-shared.js";

export interface DaemonThreadHelpers {
  ensureIdentity(identityId: string): Promise<IdentityRecord>;
  createThread(input: {
    identity: IdentityRecord;
    id?: string;
    agentKey?: string;
    model?: string;
    thinking?: CreateThreadRequestPayload["thinking"];
    inferenceProjection?: CreateThreadRequestPayload["inferenceProjection"];
    context?: Record<string, unknown>;
  }): Promise<ThreadRecord>;
  relocateThreadMedia(
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]>;
  resolveOrCreateHomeThread(input: ResolveHomeThreadRequestPayload): Promise<ThreadRecord>;
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
  handleResetHomeThread(payload: ResetHomeThreadRequestPayload): Promise<Record<string, unknown>>;
  handleSwitchHomeAgent(payload: SwitchHomeAgentRequestPayload): Promise<Record<string, unknown>>;
}

export function createDaemonThreadHelpers(
  context: PandaDaemonContext,
): DaemonThreadHelpers {
  const ensureIdentity = async (identityId: string): Promise<IdentityRecord> => {
    return identityId === createDefaultIdentityInput().id
      ? context.runtime.identityStore.ensureIdentity(createDefaultIdentityInput())
      : context.runtime.identityStore.getIdentity(identityId);
  };

  const requireDefaultAgentKey = async (
    identity: IdentityRecord,
    explicitAgentKey?: string,
  ): Promise<string> => {
    const agentKey = trimNonEmptyString(explicitAgentKey) ?? trimNonEmptyString(identity.defaultAgentKey);
    if (!agentKey) {
      throw new Error(buildMissingDefaultAgentMessage(identity));
    }

    await context.runtime.agentStore.getAgent(agentKey);
    return agentKey;
  };

  const updateIdentityDefaultAgent = async (
    identity: IdentityRecord,
    agentKey: string,
  ): Promise<IdentityRecord> => {
    if (identity.defaultAgentKey === agentKey) {
      return identity;
    }

    return context.runtime.identityStore.updateIdentity({
      identityId: identity.id,
      defaultAgentKey: agentKey,
    });
  };

  const createThread = async (input: {
    identity: IdentityRecord;
    id?: string;
    agentKey?: string;
    model?: string;
    thinking?: CreateThreadRequestPayload["thinking"];
    inferenceProjection?: CreateThreadRequestPayload["inferenceProjection"];
    context?: Record<string, unknown>;
  }): Promise<ThreadRecord> => {
    const agentKey = await requireDefaultAgentKey(input.identity, input.agentKey);
    return context.runtime.store.createThread({
      id: input.id ?? randomUUID(),
      identityId: input.identity.id,
      agentKey,
      context: {
        ...context.fallbackContext,
        // Do not persist the runner's synthetic home cwd here. Threads survive
        // restarts and deployment changes, so baking a container-only path into
        // stored thread state breaks later local resumes and other path layouts.
        identityId: input.identity.id,
        identityHandle: input.identity.handle,
        ...(input.context ?? {}),
      },
      model: input.model ?? context.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
    });
  };

  const relocateThreadMedia = async (
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]> => {
    if (media.length === 0) {
      return media;
    }

    // Move inbound channel media into the agent's home so that remote bash can
    // reach the files through the agent's mounted home directory.
    const rootDir = resolvePandaAgentMediaDir(thread.agentKey);
    return Promise.all(media.map((descriptor) => relocateMediaDescriptor(descriptor, {rootDir})));
  };

  const bindHomeThread = async (thread: ThreadRecord): Promise<void> => {
    await context.homeThreads.bindHomeThread({
      identityId: thread.identityId,
      threadId: thread.id,
    });
  };

  const resolveExistingHomeThread = async (identityId: string): Promise<ThreadRecord | null> => {
    const existing = await context.homeThreads.resolveHomeThread({identityId});
    if (!existing) {
      return null;
    }

    try {
      const thread = await context.runtime.store.getThread(existing.threadId);
      return thread.identityId === identityId ? thread : null;
    } catch (error) {
      if (isMissingThreadError(error, existing.threadId)) {
        return null;
      }

      throw error;
    }
  };

  const replaceHomeThread = async (input: {
    identity: IdentityRecord;
    source: ResetHomeThreadRequestPayload["source"] | "identity";
    agentKey?: string;
    model?: string;
    thinking?: CreateThreadRequestPayload["thinking"];
    inferenceProjection?: CreateThreadRequestPayload["inferenceProjection"];
    context?: Record<string, unknown>;
  }): Promise<{thread: ThreadRecord; previousThreadId?: string | null}> => {
    const previousHome = await resolveExistingHomeThread(input.identity.id);
    if (previousHome) {
      await context.runtime.coordinator.abort(previousHome.id, `Reset requested from ${input.source}.`);
      await context.runtime.coordinator.waitForCurrentRun(previousHome.id);
      await context.runtime.store.discardPendingInputs(previousHome.id);
    }

    const thread = await createThread({
      identity: input.identity,
      agentKey: input.agentKey,
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
      context: input.context,
    });
    if (trimNonEmptyString(input.agentKey)) {
      await updateIdentityDefaultAgent(input.identity, thread.agentKey);
    }
    await bindHomeThread(thread);

    return {
      thread,
      previousThreadId: previousHome?.id ?? null,
    };
  };

  const resolveOrCreateHomeThread = async (
    input: ResolveHomeThreadRequestPayload,
  ): Promise<ThreadRecord> => {
    const identity = await ensureIdentity(requireIdentityId(input.identityId, "resolve_home_thread"));
    const requestedAgentKey = trimNonEmptyString(input.agentKey);
    const existing = await resolveExistingHomeThread(identity.id);
    if (existing) {
      if (!requestedAgentKey || existing.agentKey === requestedAgentKey) {
        const replacementAgentKey = resolveImplicitHomeThreadReplacementAgent({
          requestedAgentKey,
          existingAgentKey: existing.agentKey,
          identityDefaultAgentKey: identity.defaultAgentKey,
        });
        if (replacementAgentKey) {
          const result = await replaceHomeThread({
            identity,
            source: "identity",
            agentKey: replacementAgentKey,
            model: input.model,
            thinking: input.thinking,
            inferenceProjection: input.inferenceProjection,
          });
          return result.thread;
        }

        return existing;
      }

      throw new Error(buildHomeAgentMismatchMessage(identity, existing.agentKey, requestedAgentKey));
    }

    const thread = await createThread({
      identity,
      agentKey: requestedAgentKey,
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
    });
    if (requestedAgentKey) {
      await updateIdentityDefaultAgent(identity, thread.agentKey);
    }
    await bindHomeThread(thread);
    return thread;
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
      try {
        const thread = await context.runtime.store.getThread(existing.threadId);
        return thread.identityId === input.identityId ? thread : null;
      } catch (error) {
        if (!isMissingThreadError(error, existing.threadId)) {
          throw error;
        }
      }
    }

    const identity = await ensureIdentity(input.identityId);
    const home = await resolveExistingHomeThread(identity.id);
    const thread = home ?? await createThread({
      identity,
      context: input.context,
    });
    if (!home) {
      await bindHomeThread(thread);
    }

    await context.conversationBindings.bindConversation({
      source: input.source,
      connectorKey: input.connectorKey,
      externalConversationId: input.externalConversationId,
      threadId: thread.id,
      metadata: input.metadata,
    });
    return thread;
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

  const handleResetHomeThread = async (
    payload: ResetHomeThreadRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const identity = await ensureIdentity(requireIdentityId(payload.identityId, "reset_home_thread"));
    const result = await replaceHomeThread({
      identity,
      source: payload.source,
      agentKey: payload.agentKey,
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
      context: payload.source === TELEGRAM_SOURCE && payload.externalConversationId
        ? {source: TELEGRAM_SOURCE}
        : undefined,
    });

    if (payload.source === TELEGRAM_SOURCE && payload.connectorKey && payload.externalConversationId) {
      await context.conversationBindings.bindConversation({
        source: TELEGRAM_SOURCE,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        threadId: result.thread.id,
        metadata: payload.commandExternalMessageId
          ? {
            kind: "telegram_reset_receipt",
            commandExternalMessageId: payload.commandExternalMessageId,
          }
          : undefined,
      });
      await context.threadRoutes.saveLastRoute({
        threadId: result.thread.id,
        route: {
          source: TELEGRAM_SOURCE,
          connectorKey: payload.connectorKey,
          externalConversationId: payload.externalConversationId,
          externalActorId: payload.externalActorId,
          externalMessageId: payload.commandExternalMessageId,
          capturedAt: Date.now(),
        },
      });
    }

    return {
      threadId: result.thread.id,
      previousThreadId: result.previousThreadId,
    };
  };

  const handleSwitchHomeAgent = async (
    payload: SwitchHomeAgentRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const identity = await ensureIdentity(requireIdentityId(payload.identityId, "switch_home_agent"));
    const requestedAgentKey = trimNonEmptyString(payload.agentKey);
    if (!requestedAgentKey) {
      throw new Error(buildMissingSwitchHomeAgentKeyMessage());
    }

    await context.runtime.agentStore.getAgent(requestedAgentKey);
    const updatedIdentity = await updateIdentityDefaultAgent(identity, requestedAgentKey);
    const result = await replaceHomeThread({
      identity: updatedIdentity,
      source: "identity",
      agentKey: requestedAgentKey,
    });

    return {
      threadId: result.thread.id,
      previousThreadId: result.previousThreadId,
    };
  };

  return {
    ensureIdentity,
    createThread,
    relocateThreadMedia,
    resolveOrCreateHomeThread,
    resolveOrCreateConversationThread,
    queueSystemReply,
    handleResetHomeThread,
    handleSwitchHomeAgent,
  };
}
