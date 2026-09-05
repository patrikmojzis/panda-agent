import {randomUUID} from "node:crypto";

import {relocateMediaDescriptor} from "../../domain/channels/media-store.js";
import type {MediaDescriptor} from "../../domain/channels/types.js";
import type {OutboundDeliveryInput} from "../../domain/channels/deliveries/types.js";
import type {IdentityRecord} from "../../domain/identity/types.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import {
  type SessionLifecycle,
  SessionCurrentThreadConflictError,
} from "../../domain/sessions/lifecycle.js";
import type {
  SessionCreationOperationRecord,
  SessionRecord,
  UpdateSessionRuntimeConfigInput,
} from "../../domain/sessions/types.js";
import {resolveCurrentSessionThread} from "../../domain/sessions/current-thread.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {BindConversationInput, ConversationBinding, ConversationLookup} from "../../domain/sessions/conversations/types.js";
import type {SessionRouteInput} from "../../domain/sessions/routes/types.js";
import type {
  CreateBranchSessionRequestPayload,
  ResetSessionRequestPayload,
  ResetSessionResult,
  ResolveMainSessionThreadRequestPayload,
} from "../../domain/threads/requests/types.js";
import {RetryableRuntimeRequestError} from "../../domain/threads/requests/errors.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {
  isMissingThreadError,
  type ThreadAbortOperationRecord,
  type ThreadRecord,
} from "../../domain/threads/runtime/types.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {isJsonObject, type JsonValue} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";
import {resolveAgentMediaDir} from "../../lib/data-dir.js";
import {requireIdentityId} from "./daemon-shared.js";
import {
  createDaemonSubagentSessionCreator,
  type DaemonSubagentSessionContext,
  type DaemonCreateSubagentSessionInput,
} from "./daemon-subagent-sessions.js";
import type {CreateSubagentSessionResult} from "./subagent-session-service.js";
import {isDeepStrictEqual} from "node:util";
import type {OutboundDeliveryRecord} from "../../domain/channels/deliveries/types.js";

export interface DaemonThreadHelperContext {
  fallbackContext: {cwd: string};
  runtime: {
    sessionLifecycle: SessionLifecycle;
    agentStore: {
      getAgent(agentKey: string): Promise<unknown>;
      listIdentityPairings(identityId: string): Promise<readonly {agentKey: string}[]>;
    };
    backgroundJobService: {
      cancelThreadJobs(threadId: string): Promise<void>;
    };
    coordinator: Pick<ThreadRuntimeCoordinator, "abort" | "runExclusively">;
    identityStore: Pick<IdentityStore, "getIdentity">;
    sessionStore: Pick<SessionStore,
      | "getMainSession"
      | "getSession"
      | "getSessionCreationOperation"
      | "recordSessionCreationOperation"
      | "recordMainSessionResolutionOperation"
    >;
    store: Pick<
      ThreadRuntimeStore,
      "getThread" | "getThreadAbortOperation"
    >;
    subagentSessions: DaemonSubagentSessionContext["subagentSessions"];
  };
  conversationBindings: {
    bindConversation(input: BindConversationInput): Promise<unknown>;
    getConversationBinding(input: ConversationLookup): Promise<ConversationBinding | null>;
  };
  outboundDeliveries: {
    enqueueDelivery(input: OutboundDeliveryInput): Promise<unknown>;
    findDeliveryByIdempotencyKey(idempotencyKey: string): Promise<OutboundDeliveryRecord | null>;
  };
  sessionRoutes: {
    saveLastRoute(input: SessionRouteInput): Promise<unknown>;
  };
}

export interface DaemonThreadHelpers {
  ensureIdentity(identityId: string): Promise<IdentityRecord>;
  createBranchSession(input: {
    operationId: string;
    replayAttempt: boolean;
    identityId: string;
    sessionId: string;
    threadId: string;
    agentKey?: string;
    model?: string;
    thinking?: CreateBranchSessionRequestPayload["thinking"];
    inferenceProjection?: CreateBranchSessionRequestPayload["inferenceProjection"];
  }): Promise<ThreadRecord>;
  createSubagentSession(input: DaemonCreateSubagentSessionInput): Promise<CreateSubagentSessionResult>;
  relocateAgentMedia(
    agentKey: string,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]>;
  relocateThreadMedia(
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]>;
  openMainSession(
    input: ResolveMainSessionThreadRequestPayload,
    operationId: string,
    replayAttempt: boolean,
  ): Promise<ThreadRecord>;
  resolveOrCreateConversationThread(input: {
    identityId: string;
    authorizedAgentKey?: string;
    authorizedActorBindingId?: string;
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
    idempotencyKey: string;
    channel: string;
    connectorKey: string;
    externalConversationId: string;
    externalActorId?: string;
    text: string;
    replyToMessageId?: string;
    threadId?: string;
  }): Promise<void>;
  findSystemReply(input: {
    idempotencyKey: string;
    channel: string;
    connectorKey: string;
    externalConversationId: string;
    externalActorId?: string;
    text: string;
    replyToMessageId?: string;
  }): Promise<OutboundDeliveryRecord | null>;
  handleResetSession(
    payload: ResetSessionRequestPayload,
    requestId: string,
    capturedAt: number,
    replayAttempt: boolean,
  ): Promise<ResetSessionResult>;
  reconcileResetSession(
    payload: ResetSessionRequestPayload,
    requestId: string,
    capturedAt: number,
  ): Promise<ResetSessionResult | null>;
}

function isChannelBoundReset(
  payload: ResetSessionRequestPayload,
): payload is ResetSessionRequestPayload & {connectorKey: string; externalConversationId: string} {
  return payload.source !== "operator" && Boolean(payload.connectorKey && payload.externalConversationId);
}

class ResetSessionConflictError extends Error {
  override readonly name = "ResetSessionConflictError";
}

export function createDaemonThreadHelpers(
  context: DaemonThreadHelperContext,
): DaemonThreadHelpers {
  const ensureIdentity = async (identityId: string): Promise<IdentityRecord> => {
    const identity = await context.runtime.identityStore.getIdentity(identityId);
    if (identity.status !== "active") {
      throw new Error(`Identity ${identity.handle} is not active.`);
    }
    return identity;
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

  const ensureMainSession = async (
    agentKey: string,
    identity?: IdentityRecord,
    initialThread?: {
      model?: string;
      thinking?: ResolveMainSessionThreadRequestPayload["thinking"];
      inferenceProjection?: ResolveMainSessionThreadRequestPayload["inferenceProjection"];
    },
    operationId?: string,
  ): Promise<{created: boolean; session: SessionRecord}> => {
    const recordResolution = async (session: SessionRecord): Promise<void> => {
      if (!operationId || !identity) return;
      try {
        await context.runtime.sessionStore.recordMainSessionResolutionOperation({
          operationId,
          identityId: identity.id,
          agentKey,
          sessionId: session.id,
        });
      } catch (error) {
        if (error instanceof RetryableRuntimeRequestError) throw error;
        // Existing-main resolution is still a durable effect. Losing the
        // response after its receipt commits must be reconciled on any claim.
        throw new RetryableRuntimeRequestError(
          `Main session operation ${operationId} could not reconcile its resolution receipt.`,
          {cause: error},
        );
      }
    };
    const existing = await context.runtime.sessionStore.getMainSession(agentKey);
    if (existing) {
      await recordResolution(existing);
      return {
        created: false,
        session: existing,
      };
    }

    const sessionId = randomUUID();
    const threadId = randomUUID();
    try {
      const created = await context.runtime.sessionLifecycle.create({
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
        ...(operationId && identity
          ? {operation: {operationId, identityId: identity.id, kind: "main" as const}}
          : {}),
      });
      return {
        created: true,
        session: created.session,
      };
    } catch (error) {
      // Main-session creation is naturally contested across independently
      // ordered ingress requests. The unique row elects the winner; losers
      // adopt it only after its initial thread is fully visible.
      const winner = await context.runtime.sessionStore.getMainSession(agentKey).catch(() => null);
      if (!winner) throw error;
      await context.runtime.store.getThread(winner.currentThreadId);
      await recordResolution(winner);
      return {created: false, session: winner};
    }
  };

  const resolveCurrentThread = async (sessionId: string): Promise<ThreadRecord> => {
    const {threadId} = await resolveCurrentSessionThread(context.runtime.sessionStore, sessionId);
    return context.runtime.store.getThread(threadId);
  };

  const createBranchSession = async (input: {
    operationId: string;
    replayAttempt: boolean;
    identityId: string;
    sessionId: string;
    threadId: string;
    agentKey?: string;
    model?: string;
    thinking?: CreateBranchSessionRequestPayload["thinking"];
    inferenceProjection?: CreateBranchSessionRequestPayload["inferenceProjection"];
  }): Promise<ThreadRecord> => {
    const {sessionId, threadId} = input;
    const threadInput = buildInitialSessionThreadInput({
      sessionId,
      id: threadId,
    });
    const runtimeConfig = buildRuntimeConfigPatch(input);
    const readReceipt = async (): Promise<ThreadRecord | null> => {
      let receipt: SessionCreationOperationRecord | null;
      try {
        receipt = await context.runtime.sessionStore.getSessionCreationOperation(input.operationId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Branch session operation ${input.operationId} could not read its creation receipt.`,
          {cause: error},
        );
      }
      if (!receipt) return null;
      if (
        receipt.identityId !== input.identityId
        || receipt.kind !== "branch"
        || receipt.sessionId !== sessionId
        || receipt.threadId !== threadId
        || (input.agentKey !== undefined && receipt.agentKey !== input.agentKey)
      ) {
        throw new Error(`Branch session operation ${input.operationId} conflicts with another target.`);
      }
      return readExisting(true);
    };
    const readExisting = async (trustReceipt = false): Promise<ThreadRecord | null> => {
      let existing: SessionRecord;
      try {
        existing = await context.runtime.sessionStore.getSession(sessionId);
      } catch (error) {
        if (error instanceof Error && error.message === `Unknown session ${sessionId}`) {
          if (trustReceipt) {
            throw new RetryableRuntimeRequestError(
              `Branch session operation ${input.operationId} receipt is not yet readable with its session.`,
              {cause: error},
            );
          }
          return null;
        }
        if (trustReceipt) {
          throw new RetryableRuntimeRequestError(
            `Branch session operation ${input.operationId} could not read its committed session.`,
            {cause: error},
          );
        }
        throw error;
      }
      if (
        existing.kind !== "branch"
        || (input.agentKey !== undefined && existing.agentKey !== input.agentKey)
        || (!trustReceipt && existing.currentThreadId !== threadId)
        || (!trustReceipt && existing.createdByIdentityId !== input.identityId)
      ) {
        throw new Error(`Branch session ${sessionId} already exists with different creation parameters.`);
      }
      let existingThread: ThreadRecord;
      try {
        existingThread = await context.runtime.store.getThread(threadId);
      } catch (error) {
        if (trustReceipt) {
          throw new RetryableRuntimeRequestError(
            `Branch session operation ${input.operationId} could not read its committed thread.`,
            {cause: error},
          );
        }
        throw error;
      }
      if (existingThread.sessionId !== sessionId) {
        throw new Error(`Branch thread ${threadId} belongs to another session.`);
      }
      // Creation replay validates the immutable identity only. Reapplying its
      // original config would clobber a later explicit update_thread request.
      return existingThread;
    };

    if (input.replayAttempt) {
      const replay = await readReceipt();
      if (replay) return replay;
    }

    const identity = await ensureIdentity(input.identityId);
    const agentKey = await resolveAccessibleAgentKey(identity, input.agentKey);

    try {
      const created = await context.runtime.sessionLifecycle.create({
        session: {
          id: sessionId,
          agentKey,
          kind: "branch",
          currentThreadId: threadId,
          createdByIdentityId: input.identityId,
        },
        thread: threadInput,
        runtimeConfig,
        operation: {
          operationId: input.operationId,
          identityId: input.identityId,
          kind: "branch",
        },
      });
      return created.thread;
    } catch (error) {
      const racedReplay = await readReceipt();
      if (racedReplay) {
        return racedReplay;
      }
      throw error;
    }
  };

  const createSubagentSession = createDaemonSubagentSessionCreator({
    ensureIdentity,
    resolveAccessibleAgentKey,
    sessions: context.runtime.sessionStore,
    subagentSessions: context.runtime.subagentSessions,
  });

  const relocateAgentMedia = async (
    agentKey: string,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]> => {
    if (media.length === 0) {
      return media;
    }

    const rootDir = resolveAgentMediaDir(agentKey);
    // A failed relocation settles the owning request and may release its
    // staging receipts. Join every sibling first so none can publish a late
    // manifest update after settlement cleanup has started.
    const settled = await Promise.allSettled(
      media.map((descriptor) => relocateMediaDescriptor(descriptor, {rootDir})),
    );
    const failure = settled.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    return settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
  };

  const relocateThreadMedia = async (
    thread: ThreadRecord,
    media: readonly MediaDescriptor[],
  ): Promise<readonly MediaDescriptor[]> => {
    const session = await context.runtime.sessionStore.getSession(thread.sessionId);
    return relocateAgentMedia(session.agentKey, media);
  };

  const openMainSession = async (
    input: ResolveMainSessionThreadRequestPayload,
    operationId: string,
    replayAttempt: boolean,
  ): Promise<ThreadRecord> => {
    if (replayAttempt) {
      let receipt: SessionCreationOperationRecord | null;
      try {
        receipt = await context.runtime.sessionStore.getSessionCreationOperation(operationId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Main session operation ${operationId} could not read its creation receipt.`,
          {cause: error},
        );
      }
      if (receipt) {
        if (
          receipt.identityId !== input.identityId
          || receipt.kind !== "main"
          || (input.agentKey !== undefined && receipt.agentKey !== input.agentKey)
        ) {
          throw new Error(`Main session operation ${operationId} conflicts with another target.`);
        }
        try {
          return await context.runtime.store.getThread(receipt.threadId);
        } catch (error) {
          throw new RetryableRuntimeRequestError(
            `Main session operation ${operationId} could not read its committed thread.`,
            {cause: error},
          );
        }
      }
    }
    const identity = await ensureIdentity(requireIdentityId(input.identityId, "resolve_main_session_thread"));
    const agentKey = await resolveAccessibleAgentKey(identity, input.agentKey);
    await ensureMainSession(agentKey, identity, {
      model: input.model,
      thinking: input.thinking,
      inferenceProjection: input.inferenceProjection,
    }, operationId);
    let receipt: SessionCreationOperationRecord | null;
    try {
      receipt = await context.runtime.sessionStore.getSessionCreationOperation(operationId);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Main session operation ${operationId} could not read its creation receipt.`,
        {cause: error},
      );
    }
    if (!receipt) {
      throw new Error(`Main session operation ${operationId} did not retain its resolution receipt.`);
    }
    // Resolving an existing main session is read-only. Runtime config has its
    // own ordered update_thread command and must not be replayed by resolution.
    try {
      return await context.runtime.store.getThread(receipt.threadId);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Main session operation ${operationId} could not read its committed thread.`,
        {cause: error},
      );
    }
  };

  const resolveOrCreateConversationThread = async (input: {
    identityId: string;
    authorizedAgentKey?: string;
    authorizedActorBindingId?: string;
    source: string;
    connectorKey: string;
    externalConversationId: string;
    metadata?: JsonValue;
  }): Promise<ThreadRecord | null> => {
    const identity = await ensureIdentity(input.identityId);
    const existing = await context.conversationBindings.getConversationBinding({
      source: input.source,
      connectorKey: input.connectorKey,
      externalConversationId: input.externalConversationId,
    });
    if (existing) {
      const session = await context.runtime.sessionStore.getSession(existing.sessionId);
      const pairings = await context.runtime.agentStore.listIdentityPairings(identity.id);
      const authority = isJsonObject(existing.metadata) && isJsonObject(existing.metadata.channelAuthorization)
        ? existing.metadata.channelAuthorization
        : null;
      if (
        (input.authorizedAgentKey && session.agentKey !== input.authorizedAgentKey)
        || (input.authorizedActorBindingId && (
          authority?.identityId !== identity.id
          || authority.agentKey !== input.authorizedAgentKey
          || authority.actorBindingId !== input.authorizedActorBindingId
        ))
        || !pairings.some((pairing) => pairing.agentKey === session.agentKey)
      ) {
        return null;
      }
      return resolveCurrentThread(existing.sessionId);
    }

    const pairings = await context.runtime.agentStore.listIdentityPairings(identity.id);
    const agentKey = input.authorizedAgentKey
      ? pairings.some((pairing) => pairing.agentKey === input.authorizedAgentKey)
        ? input.authorizedAgentKey
        : null
      : pairings.length === 1
        ? pairings[0]!.agentKey
        : null;
    if (!agentKey) {
      return null;
    }

    const {session} = await ensureMainSession(agentKey, identity);
    await context.conversationBindings.bindConversation({
      source: input.source,
      connectorKey: input.connectorKey,
      externalConversationId: input.externalConversationId,
      sessionId: session.id,
      metadata: input.authorizedActorBindingId
        ? {
            ...(isJsonObject(input.metadata) ? input.metadata : {}),
            channelAuthorization: {
              identityId: identity.id,
              agentKey,
              actorBindingId: input.authorizedActorBindingId,
            },
          }
        : input.metadata,
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

  type SystemReplyInput = {
    idempotencyKey: string;
    channel: string;
    connectorKey: string;
    externalConversationId: string;
    externalActorId?: string;
    text: string;
    replyToMessageId?: string;
    threadId?: string;
  };
  const buildSystemReplyDelivery = (input: SystemReplyInput): OutboundDeliveryInput => ({
      idempotencyKey: input.idempotencyKey,
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
  const queueSystemReply = async (input: SystemReplyInput): Promise<void> => {
    await context.outboundDeliveries.enqueueDelivery(buildSystemReplyDelivery(input));
  };
  const findSystemReply = async (input: Omit<SystemReplyInput, "threadId">): Promise<OutboundDeliveryRecord | null> => {
    let existing: OutboundDeliveryRecord | null;
    try {
      existing = await context.outboundDeliveries.findDeliveryByIdempotencyKey(input.idempotencyKey);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `System reply operation ${input.idempotencyKey} could not read its delivery receipt.`,
        {cause: error},
      );
    }
    if (!existing) return null;
    const expected = buildSystemReplyDelivery(input);
    if (
      existing.channel !== expected.channel
      || !isDeepStrictEqual(existing.target, expected.target)
      || !isDeepStrictEqual(existing.items, expected.items)
    ) {
      throw new Error(`System reply operation ${input.idempotencyKey} conflicts with another delivery.`);
    }
    return existing;
  };

  const findResetSessionResult = async (
    payload: ResetSessionRequestPayload,
    requestId: string,
  ): Promise<ResetSessionResult | null> => {
    const resetThreadId = `reset:${requestId}`;
    let thread: ThreadRecord;
    try {
      thread = await context.runtime.store.getThread(resetThreadId);
    } catch (error) {
      if (isMissingThreadError(error, resetThreadId)) return null;
      throw new RetryableRuntimeRequestError(
        `Reset operation ${requestId} could not read its committed thread.`,
        {cause: error},
      );
    }
    if (
      !thread.replacesThreadId
      || (payload.sessionId !== undefined && thread.sessionId !== payload.sessionId)
      || (payload.threadId !== undefined && thread.replacesThreadId !== payload.threadId)
    ) {
      throw new Error(`Reset operation ${requestId} conflicts with existing thread ${resetThreadId}.`);
    }
    return {
      threadId: thread.id,
      previousThreadId: thread.replacesThreadId,
      sessionId: thread.sessionId,
      replayed: true,
    };
  };

  const findResetMainSessionResolution = async (
    payload: ResetSessionRequestPayload,
    requestId: string,
  ): Promise<SessionCreationOperationRecord | null> => {
    let receipt: SessionCreationOperationRecord | null;
    try {
      receipt = await context.runtime.sessionStore.getSessionCreationOperation(requestId);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Reset operation ${requestId} could not read its main-session receipt.`,
        {cause: error},
      );
    }
    if (!receipt) return null;
    if (
      receipt.kind !== "main"
      || (payload.identityId !== undefined && receipt.identityId !== payload.identityId)
      || (payload.agentKey !== undefined && receipt.agentKey !== payload.agentKey)
    ) {
      throw new Error(`Reset operation ${requestId} conflicts with another main-session resolution.`);
    }
    return receipt;
  };

  const findResetAbortOperation = async (
    payload: ResetSessionRequestPayload,
    requestId: string,
  ): Promise<ThreadAbortOperationRecord | null> => {
    let receipt: ThreadAbortOperationRecord | null;
    try {
      receipt = await context.runtime.store.getThreadAbortOperation(requestId);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Reset operation ${requestId} could not read its abort receipt.`,
        {cause: error},
      );
    }
    if (!receipt) return null;
    const expectedReason = `Reset requested from ${payload.source}.`;
    if (receipt.reason !== expectedReason || !receipt.blocksNewRuns) {
      throw new Error(`Reset operation ${requestId} conflicts with another abort request.`);
    }
    return receipt;
  };

  const buildResetChannelRouting = (
    payload: ResetSessionRequestPayload,
    capturedAt: number,
    sessionId: string,
    identityId?: string,
  ): {conversation: BindConversationInput; route: SessionRouteInput} | undefined => {
    if (!isChannelBoundReset(payload)) return undefined;
    return {
      conversation: {
        source: payload.source,
        connectorKey: payload.connectorKey,
        externalConversationId: payload.externalConversationId,
        sessionId,
        metadata: payload.externalMessageId
          ? {kind: "channel_reset_receipt", externalMessageId: payload.externalMessageId}
          : undefined,
      },
      route: {
        sessionId,
        identityId,
        route: {
          source: payload.source,
          connectorKey: payload.connectorKey,
          externalConversationId: payload.externalConversationId,
          externalActorId: payload.externalActorId,
          externalMessageId: payload.externalMessageId,
          capturedAt,
        },
      },
    };
  };

  const resetSession = async (input: {
    sessionId: string;
    source: string;
    requestId: string;
    model?: string;
    thinking?: ResetSessionRequestPayload["thinking"];
    inferenceProjection?: ResetSessionRequestPayload["inferenceProjection"];
    abortOperation?: ThreadAbortOperationRecord;
    channelRouting?: {
      conversation: BindConversationInput;
      route: SessionRouteInput;
    };
  }): Promise<{thread: ThreadRecord; previousThreadId: string; replayed: boolean}> => {
    const resetThreadId = `reset:${input.requestId}`;
    const readReplay = async (): Promise<{
      thread: ThreadRecord;
      previousThreadId: string;
      replayed: true;
    } | null> => {
      const replay = await findResetSessionResult({
        source: input.source,
        sessionId: input.sessionId,
      }, input.requestId);
      if (!replay) return null;
      let thread: ThreadRecord;
      try {
        thread = await context.runtime.store.getThread(replay.threadId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Reset operation ${input.requestId} could not read its committed thread.`,
          {cause: error},
        );
      }
      return {
        thread,
        previousThreadId: replay.previousThreadId,
        replayed: true,
      };
    };

    const abortReason = `Reset requested from ${input.source}.`;
    let abortRecorded = false;
    const persistAbort = async (): Promise<void> => {
      if (abortRecorded) return;
      try {
        await context.runtime.coordinator.abort(
          previousThread.id,
          abortReason,
          input.requestId,
          {blocksNewRuns: true},
        );
        abortRecorded = true;
      } catch (error) {
        if (error instanceof RetryableRuntimeRequestError) throw error;
        throw new RetryableRuntimeRequestError(
          `Reset operation ${input.requestId} could not reconcile its abort receipt.`,
          {cause: error},
        );
      }
    };
    let session: SessionRecord;
    let previousThread: ThreadRecord;
    if (input.abortOperation) {
      if (input.abortOperation.reason !== abortReason) {
        throw new Error(`Reset operation ${input.requestId} conflicts with another abort request.`);
      }
      try {
        previousThread = await context.runtime.store.getThread(input.abortOperation.threadId);
        session = await context.runtime.sessionStore.getSession(input.sessionId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Reset operation ${input.requestId} could not read its abort target.`,
          {cause: error},
        );
      }
      if (previousThread.sessionId !== session.id) {
        throw new Error(`Reset operation ${input.requestId} abort target belongs to another session.`);
      }
    } else {
      const current = await resolveCurrentSessionThread(context.runtime.sessionStore, input.sessionId);
      session = current.session;
      previousThread = await context.runtime.store.getThread(current.threadId);
    }
    try {
      return await context.runtime.coordinator.runExclusively(previousThread.id, async ({signal, owner}) => {
        signal.throwIfAborted();
        await persistAbort();
        const current = await resolveCurrentSessionThread(context.runtime.sessionStore, session.id);
        if (current.threadId === resetThreadId) {
          const racedReplay = await readReplay();
          if (racedReplay) return racedReplay;
          throw new ResetSessionConflictError(
            `Reset thread ${resetThreadId} is current but missing its durable lineage.`,
          );
        }
        if (current.threadId !== previousThread.id) {
          throw new ResetSessionConflictError(
            `Session ${session.id} changed threads while reset was waiting to start.`,
          );
        }

        await context.runtime.backgroundJobService.cancelThreadJobs(previousThread.id);
        signal.throwIfAborted();

        const nextThread = {
          ...buildInitialSessionThreadInput({
            sessionId: session.id,
            id: resetThreadId,
          }),
          replacesThreadId: previousThread.id,
        };
        const runtimeConfig = buildRuntimeConfigPatch(input);
        const thread = await context.runtime.sessionLifecycle.reset({
          thread: nextThread,
          previousThreadId: previousThread.id,
          owner,
          session: {
            sessionId: session.id,
            currentThreadId: nextThread.id,
          },
          runtimeConfig,
          runtimeConfigOperationId: input.requestId,
          channelRouting: input.channelRouting,
        });

        return {
          thread,
          previousThreadId: previousThread.id,
          replayed: false,
        };
      }, {
        abortActiveReason: new Error(abortReason),
        beforeActiveAbort: persistAbort,
      });
    } catch (error) {
      const racedReplay = await readReplay();
      if (racedReplay) {
        return racedReplay;
      }
      if (
        error instanceof ResetSessionConflictError
        || error instanceof SessionCurrentThreadConflictError
        || error instanceof RetryableRuntimeRequestError
      ) {
        throw error;
      }
      throw new RetryableRuntimeRequestError(
        `Reset operation ${input.requestId} committed its abort but did not finish replacing the thread.`,
        {cause: error},
      );
    }
  };

  const reconcileResetSession = async (
    payload: ResetSessionRequestPayload,
    requestId: string,
    capturedAt: number,
  ): Promise<ResetSessionResult | null> => {
    const completed = await findResetSessionResult(payload, requestId);
    if (completed) return completed;

    const mainResolution = await findResetMainSessionResolution(payload, requestId);
    const abortOperation = await findResetAbortOperation(payload, requestId);
    if (!mainResolution && !abortOperation) return null;

    let sessionId: string;
    let identityId: string | undefined;
    if (mainResolution) {
      sessionId = mainResolution.sessionId;
      identityId = mainResolution.identityId;
    } else {
      let previousThread: ThreadRecord;
      let session: SessionRecord;
      try {
        previousThread = await context.runtime.store.getThread(abortOperation!.threadId);
        session = await context.runtime.sessionStore.getSession(previousThread.sessionId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Reset operation ${requestId} could not read its authorized abort target.`,
          {cause: error},
        );
      }
      if (
        (payload.sessionId !== undefined && payload.sessionId !== session.id)
        || (payload.threadId !== undefined && payload.threadId !== previousThread.id)
      ) {
        throw new Error(`Reset operation ${requestId} abort receipt conflicts with another target.`);
      }
      sessionId = session.id;
      identityId = session.createdByIdentityId;
    }

    const result = await resetSession({
      sessionId,
      source: payload.source,
      requestId,
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
      abortOperation: abortOperation ?? undefined,
      channelRouting: buildResetChannelRouting(payload, capturedAt, sessionId, identityId),
    });
    return {
      threadId: result.thread.id,
      previousThreadId: result.previousThreadId,
      sessionId,
      ...(result.replayed ? {replayed: true} : {}),
    };
  };

  const handleResetSession = async (
    payload: ResetSessionRequestPayload,
    requestId: string,
    capturedAt: number,
    replayAttempt: boolean,
  ): Promise<ResetSessionResult> => {
    const committed = replayAttempt
      ? await reconcileResetSession(payload, requestId, capturedAt)
      : await findResetSessionResult(payload, requestId);
    if (committed) return committed;

    if (isChannelBoundReset(payload)) {
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
          ? (await ensureMainSession(
              await resolveAccessibleAgentKey(identity, payload.agentKey),
              identity,
              undefined,
              requestId,
            )).session.id
          : null);
      if (!sessionId) {
        throw new Error("Cannot reset an unbound conversation without a paired identity.");
      }

      const result = await resetSession({
        sessionId,
        source: payload.source,
        requestId,
        model: payload.model,
        thinking: payload.thinking,
        inferenceProjection: payload.inferenceProjection,
        channelRouting: buildResetChannelRouting(payload, capturedAt, sessionId, identity?.id),
      });

      return {
        threadId: result.thread.id,
        previousThreadId: result.previousThreadId,
        sessionId,
        ...(result.replayed ? {replayed: true} : {}),
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
        requestId,
        model: payload.model,
        thinking: payload.thinking,
        inferenceProjection: payload.inferenceProjection,
      });

      return {
        threadId: result.thread.id,
        previousThreadId: result.previousThreadId,
        sessionId: session.id,
        ...(result.replayed ? {replayed: true} : {}),
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
      session = (await ensureMainSession(
        await resolveAccessibleAgentKey(identity, payload.agentKey),
        identity,
        undefined,
        requestId,
      )).session;
    }
    const result = await resetSession({
      sessionId: session.id,
      source: payload.source,
      requestId,
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
    });

    return {
      threadId: result.thread.id,
      previousThreadId: result.previousThreadId,
      sessionId: session.id,
      ...(result.replayed ? {replayed: true} : {}),
    };
  };

  return {
    ensureIdentity,
    createBranchSession,
    createSubagentSession,
    relocateAgentMedia,
    relocateThreadMedia,
    openMainSession,
    resolveOrCreateConversationThread,
    resolveBoundConversationThread,
    queueSystemReply,
    findSystemReply,
    handleResetSession,
    reconcileResetSession,
  };
}
