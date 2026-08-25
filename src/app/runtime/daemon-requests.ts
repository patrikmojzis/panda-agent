import type {
  AbortThreadRequestPayload,
  ArchiveSessionRequestPayload,
  CompactSessionRequestPayload,
  CompactThreadRequestPayload,
  CreateBranchSessionRequestPayload,
  CreateSubagentSessionRequestPayload,
  ResolveThreadRunConfigRequestPayload,
  RestoreSessionRequestPayload,
  RuntimeRequestRecord,
  TuiInputRequestPayload,
  UpdateThreadRequestPayload,
} from "../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {ThreadInputAdmissionBlockedError} from "../../domain/threads/runtime/store.js";
import {DEFAULT_THREAD_RUN_ABORT_REASON, isMissingThreadError} from "../../domain/threads/runtime/types.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {handleA2AMessageRequest} from "../../integrations/channels/a2a/request-handler.js";
import {handleDiscordMessageRequest} from "../../integrations/channels/discord/request-handler.js";
import {renderDiscordLiveVoiceDelegation} from "../../integrations/channels/discord/voice-delegation.js";
import {handleLiveVoiceDelegationRequest} from "../../integrations/voice/request-handler.js";
import type {LiveVoiceRepo} from "../../domain/live-voice/repo.js";
import {
  handleTelegramReactionRequest,
  handleTelegramRuntimeMessageRequest,
} from "../../integrations/channels/telegram/request-handler.js";
import {handleTuiInputRequest} from "../../integrations/channels/tui/request-handler.js";
import {
  handleWhatsAppMessageRequest,
  handleWhatsAppReactionRequest,
} from "../../integrations/channels/whatsapp/request-handler.js";
import type {DaemonThreadHelpers} from "./daemon-threads.js";
import {readSubagentSessionMetadata} from "../../domain/subagents/session-metadata.js";
import {requireIdentityId} from "./daemon-shared.js";
import type {SessionCompactionService} from "./session-compaction-service.js";
import type {SessionArchiveService} from "./session-archive-service.js";
import {
  isRetryableRuntimeInfrastructureError,
  RetryableRuntimeRequestError,
} from "../../domain/threads/requests/errors.js";
import {A2A_SOURCE} from "../../domain/a2a/constants.js";
import {DISCORD_SOURCE} from "../../integrations/channels/discord/config.js";
import {TELEGRAM_SOURCE} from "../../integrations/channels/telegram/config.js";
import {TUI_CONVERSATION_ID, TUI_SOURCE} from "../../integrations/channels/tui/helpers.js";
import {WHATSAPP_SOURCE} from "../../integrations/channels/whatsapp/config.js";

export interface DaemonRequestProcessorContext {
  runtime: {
    coordinator: Pick<
      ThreadRuntimeCoordinator,
      "abort" | "resolveThreadRunConfig" | "runExclusively" | "submitInput" | "submitSessionInput"
    >;
    identityStore: Pick<IdentityStore, "getIdentity" | "resolveIdentityBinding">;
    sessionStore: Pick<
      SessionStore,
      "getSession" | "getSessionRuntimeConfigOperation" | "updateSessionRuntimeConfigOnce"
    >;
    sessionCompaction: Pick<SessionCompactionService, "compactSession" | "compactThread">;
    sessionArchive: Pick<SessionArchiveService, "archive" | "restore">;
    store: DaemonRequestStore;
  };
  a2aBindings: Parameters<typeof handleA2AMessageRequest>[1]["bindings"];
  liveVoice: LiveVoiceRepo;
}

type DaemonRequestStore = Pick<
  ThreadRuntimeStore,
  | "commitCompaction"
  | "findInput"
  | "getThread"
  | "getThreadAbortOperation"
  | "hasPendingWake"
  | "loadActiveTranscript"
>;

export type DaemonRequestThreadHelpers = Pick<
  DaemonThreadHelpers,
  | "createBranchSession"
  | "createSubagentSession"
  | "ensureIdentity"
  | "handleResetSession"
  | "findSystemReply"
  | "openMainSession"
  | "queueSystemReply"
  | "reconcileResetSession"
  | "relocateAgentMedia"
  | "relocateThreadMedia"
  | "resolveBoundConversationThread"
  | "resolveOrCreateConversationThread"
>;

export function createDaemonRequestProcessor(
  context: DaemonRequestProcessorContext,
  threads: DaemonRequestThreadHelpers,
): (request: RuntimeRequestRecord, signal?: AbortSignal) => Promise<unknown> {
  const recoverCommittedInput = async (
    request: RuntimeRequestRecord,
    force = false,
  ): Promise<Record<string, unknown> | null> => {
    if (!force && (request.executionAttempts ?? 1) <= 1) return null;

    const expected = (() => {
      switch (request.kind) {
        case "a2a_message":
          return {
            source: A2A_SOURCE,
            channelId: request.payload.fromSessionId,
            externalMessageId: request.payload.externalMessageId,
            sessionId: request.payload.toSessionId,
          };
        case "discord_message":
          return {
            source: DISCORD_SOURCE,
            connectorKey: request.payload.connectorKey,
            channelId: request.payload.externalConversationId,
            externalMessageId: request.payload.externalMessageId,
          };
        case "telegram_message":
          return {
            source: TELEGRAM_SOURCE,
            connectorKey: request.payload.connectorKey,
            channelId: request.payload.externalConversationId,
            externalMessageId: request.payload.externalMessageId,
          };
        case "telegram_reaction":
          return {
            source: TELEGRAM_SOURCE,
            connectorKey: request.payload.connectorKey,
            channelId: request.payload.externalConversationId,
            externalMessageId: `telegram-reaction:${request.payload.updateId}`,
          };
        case "whatsapp_message":
        case "whatsapp_reaction":
          return {
            source: WHATSAPP_SOURCE,
            connectorKey: request.payload.connectorKey,
            channelId: request.payload.externalConversationId,
            externalMessageId: request.payload.externalMessageId,
          };
        case "live_voice_delegation":
          return {
            externalMessageId: request.payload.liveVoiceTurnId,
            sessionId: request.payload.sessionId,
          };
        case "tui_input":
          return {
            source: TUI_SOURCE,
            channelId: TUI_CONVERSATION_ID,
            externalMessageId: request.payload.externalMessageId,
            ...(request.payload.threadId ? {threadId: request.payload.threadId} : {}),
          };
        default:
          return null;
      }
    })();
    if (!expected) return null;

    let committed;
    try {
      committed = await context.runtime.store.findInput(request.id);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Runtime request ${request.id} committed input could not be reconciled.`,
        {cause: error},
      );
    }
    if (!committed) return null;
    if (
      (expected.source !== undefined && committed.source !== expected.source)
      || (expected.connectorKey !== undefined && committed.connectorKey !== expected.connectorKey)
      || (expected.channelId !== undefined && committed.channelId !== expected.channelId)
      || committed.externalMessageId !== expected.externalMessageId
      || ("threadId" in expected && expected.threadId !== undefined && committed.threadId !== expected.threadId)
    ) {
      throw new Error(`Runtime request ${request.id} input id is bound to another operation.`);
    }
    if (expected.sessionId !== undefined) {
      let thread;
      try {
        thread = await context.runtime.store.getThread(committed.threadId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Runtime request ${request.id} committed input target could not be reconciled.`,
          {cause: error},
        );
      }
      if (thread.sessionId !== expected.sessionId) {
        throw new Error(`Runtime request ${request.id} input belongs to another session.`);
      }
    }
    // The request id is also the input id. Once that row exists, its target is
    // the immutable routing/auth snapshot; replay must not consult mutable
    // pairings and accidentally reinterpret an already committed event.
    return {
      status: "queued",
      threadId: committed.threadId,
      ...(request.kind === "live_voice_delegation"
        ? {liveVoiceTurnId: request.payload.liveVoiceTurnId}
        : {}),
    };
  };

  const handleTuiInput = async (
    payload: TuiInputRequestPayload,
    inputId: string,
    requestCreatedAt: number,
    replayAttempt: boolean,
  ): Promise<Record<string, unknown>> => {
    const identityId = requireIdentityId(payload.identityId, "tui_input");
    const thread = payload.threadId
      ? await context.runtime.store.getThread(payload.threadId)
      : await threads.openMainSession({
        identityId,
      }, inputId, replayAttempt);

    return handleTuiInputRequest(payload, identityId, thread, {
      capturedAt: requestCreatedAt,
      coordinator: context.runtime.coordinator,
      enqueueOptions: {inputId},
    });
  };

  const handleCreateBranchSession = async (
    payload: CreateBranchSessionRequestPayload,
    operationId: string,
    replayAttempt: boolean,
  ): Promise<Record<string, unknown>> => {
    const thread = await threads.createBranchSession({
      operationId,
      replayAttempt,
      identityId: requireIdentityId(payload.identityId, "create_branch_session"),
      sessionId: payload.sessionId,
      threadId: payload.threadId,
      agentKey: payload.agentKey,
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
    });
    return {threadId: thread.id};
  };

  const handleCreateSubagentSession = async (
    payload: CreateSubagentSessionRequestPayload,
    operationId: string,
    replayAttempt: boolean,
  ): Promise<Record<string, unknown>> => {
    const created = await threads.createSubagentSession({
      operationId,
      replayAttempt,
      identityId: requireIdentityId(payload.identityId, "create_subagent_session"),
      sessionId: payload.sessionId,
      threadId: payload.threadId,
      agentKey: payload.agentKey,
      parentSessionId: payload.parentSessionId,
      prompt: payload.prompt,
      context: payload.context,
      profile: payload.profile,
      execution: payload.execution,
      environmentId: payload.environmentId,
      credentialAllowlist: payload.credentialAllowlist,
      credentialRefAllowlist: payload.credentialRefAllowlist,
      toolGroups: payload.toolGroups,
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
    });
    const metadata = readSubagentSessionMetadata(created.session.metadata);
    return {
      threadId: created.thread.id,
      sessionId: created.session.id,
      profile: metadata?.profile.slug ?? metadata?.role ?? payload.profile ?? "workspace",
      execution: metadata?.execution ?? payload.execution ?? "agent_workspace",
      ...(metadata?.environmentId ? {environmentId: metadata.environmentId} : {}),
      ...(created.environment
        ? {
          environment: {
            id: created.environment.id,
            runnerCwd: created.environment.runnerCwd,
            rootPath: created.environment.rootPath,
            metadata: created.environment.metadata,
          },
        }
        : {}),
    };
  };

  const handleAbortThread = async (
    payload: AbortThreadRequestPayload,
    requestId: string,
    replayAttempt: boolean,
  ): Promise<Record<string, unknown>> => {
    const reason = payload.reason ?? DEFAULT_THREAD_RUN_ABORT_REASON;
    if (replayAttempt) {
      let receipt;
      try {
        receipt = await context.runtime.store.getThreadAbortOperation(requestId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Abort operation ${requestId} could not read its receipt.`,
          {cause: error},
        );
      }
      if (receipt) {
        if (receipt.threadId !== payload.threadId || receipt.reason !== reason || receipt.blocksNewRuns) {
          throw new Error(`Abort operation ${requestId} conflicts with another request.`);
        }
        return {aborted: receipt.runId !== undefined};
      }
      try {
        await context.runtime.store.getThread(payload.threadId);
      } catch (error) {
        if (isMissingThreadError(error, payload.threadId)) throw error;
        throw new RetryableRuntimeRequestError(
          `Abort operation ${requestId} could not verify its target thread.`,
          {cause: error},
        );
      }
    }
    try {
      const aborted = await context.runtime.coordinator.abort(payload.threadId, reason, requestId);
      return {aborted};
    } catch (error) {
      if (error instanceof RetryableRuntimeRequestError) throw error;
      throw new RetryableRuntimeRequestError(
        `Abort operation ${requestId} could not be reconciled.`,
        {cause: error},
      );
    }
  };

  const handleCompactThread = async (
    payload: CompactThreadRequestPayload,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    return {...await context.runtime.sessionCompaction.compactThread(
      payload.threadId,
      payload.customInstructions,
      requestId,
      signal,
    )};
  };

  const handleCompactSession = async (
    payload: CompactSessionRequestPayload,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    return {...await context.runtime.sessionCompaction.compactSession(
      payload.sessionId,
      payload.customInstructions,
      requestId,
      signal,
    )};
  };

  const handleResolveThreadRunConfig = async (
    payload: ResolveThreadRunConfigRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const config = await context.runtime.coordinator.resolveThreadRunConfig(payload.threadId);
    return {
      model: config.model,
      thinking: config.thinking ?? null,
      ...(config.inferenceProjection ? {inferenceProjection: config.inferenceProjection} : {}),
    };
  };

  const handleArchiveSession = async (
    payload: ArchiveSessionRequestPayload,
    requestId: string,
  ): Promise<Record<string, unknown>> => {
    const result = await context.runtime.sessionArchive.archive(payload.sessionId, requestId);
    return {
      sessionId: result.session.id,
      threadId: result.session.currentThreadId,
      archivedAt: result.session.archivedAt ?? null,
      discardedInputs: result.discardedInputs,
      cancelledTaskRuns: result.cancelledTaskRuns,
      failedWatchRuns: result.failedWatchRuns,
      failedDeliveries: result.failedDeliveries,
      failedActions: result.failedActions,
      failedVoiceTurns: result.failedVoiceTurns,
      stoppedSubagents: result.stoppedSubagents,
    };
  };

  const handleRestoreSession = async (
    payload: RestoreSessionRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const session = await context.runtime.sessionArchive.restore(payload.sessionId);
    return {sessionId: session.id, threadId: session.currentThreadId, restored: true};
  };

  const handleUpdateThread = async (
    payload: UpdateThreadRequestPayload,
    requestId: string,
    replayAttempt: boolean,
  ): Promise<Record<string, unknown>> => {
    if (replayAttempt) {
      let receipt;
      try {
        receipt = await context.runtime.sessionStore.getSessionRuntimeConfigOperation(requestId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Runtime config operation ${requestId} could not be reconciled.`,
          {cause: error},
        );
      }
      if (receipt) {
        if (receipt.threadId !== payload.threadId) {
          throw new Error(`Session runtime config operation ${requestId} conflicts with another target.`);
        }
        return {threadId: receipt.threadId};
      }
    }
    const existingThread = await context.runtime.store.getThread(payload.threadId);
    if (Object.keys(payload.update).length > 0) {
      try {
        await context.runtime.sessionStore.updateSessionRuntimeConfigOnce(
          requestId,
          existingThread.id,
          {
            sessionId: existingThread.sessionId,
            ...payload.update,
          },
        );
      } catch (error) {
        if (error instanceof RetryableRuntimeRequestError) throw error;
        // A connection can fail after both the config patch and its receipt
        // commit. This remains ambiguous on every attempt, not only the first.
        throw new RetryableRuntimeRequestError(
          `Runtime config operation ${requestId} could not be reconciled.`,
          {cause: error},
        );
      }
    }
    return {threadId: existingThread.id};
  };

  const processRequest = async (request: RuntimeRequestRecord, signal?: AbortSignal): Promise<unknown> => {
    const committedInput = await recoverCommittedInput(request);
    if (committedInput) return committedInput;

    const enqueueOptions = {inputId: request.id};
    switch (request.kind) {
      case "a2a_message":
        return handleA2AMessageRequest(request.payload, {
          bindings: context.a2aBindings,
          coordinator: context.runtime.coordinator,
          enqueueOptions,
          sessions: context.runtime.sessionStore,
          relocateAgentMedia: threads.relocateAgentMedia,
        });
      case "discord_message":
        return handleDiscordMessageRequest(request.payload, {
          capturedAt: request.createdAt,
          coordinator: context.runtime.coordinator,
          enqueueOptions,
          identityStore: context.runtime.identityStore,
          threads,
        });
      case "live_voice_delegation":
        return handleLiveVoiceDelegationRequest(request.payload, {
          voice: context.liveVoice,
          coordinator: context.runtime.coordinator,
          enqueueOptions,
          store: context.runtime.store,
          sessions: context.runtime.sessionStore,
          identityStore: context.runtime.identityStore,
          renderDelegation: renderDiscordLiveVoiceDelegation,
        });
      case "telegram_message":
        return handleTelegramRuntimeMessageRequest(request.payload, {
          capturedAt: request.createdAt,
          coordinator: context.runtime.coordinator,
          enqueueOptions,
          identityStore: context.runtime.identityStore,
          threads,
          replayAttempt: request.executionAttempts > 1,
        });
      case "telegram_reaction":
        return handleTelegramReactionRequest(request.payload, {
          capturedAt: request.createdAt,
          coordinator: context.runtime.coordinator,
          enqueueOptions,
          identityStore: context.runtime.identityStore,
          threads,
        });
      case "whatsapp_message":
        return handleWhatsAppMessageRequest(request.payload, {
          capturedAt: request.createdAt,
          coordinator: context.runtime.coordinator,
          enqueueOptions,
          identityStore: context.runtime.identityStore,
          threads,
        });
      case "whatsapp_reaction":
        return handleWhatsAppReactionRequest(request.payload, {
          capturedAt: request.createdAt,
          coordinator: context.runtime.coordinator,
          enqueueOptions,
          identityStore: context.runtime.identityStore,
          threads,
        });
      case "tui_input":
        return handleTuiInput(request.payload, request.id, request.createdAt, request.executionAttempts > 1);
      case "create_branch_session":
        return handleCreateBranchSession(request.payload, request.id, request.executionAttempts > 1);
      case "create_subagent_session":
        return handleCreateSubagentSession(request.payload, request.id, request.executionAttempts > 1);
      case "resolve_main_session_thread": {
        const thread = await threads.openMainSession(
          request.payload,
          request.id,
          request.executionAttempts > 1,
        );
        return {threadId: thread.id};
      }
      case "resolve_thread_run_config":
        return handleResolveThreadRunConfig(request.payload);
      case "reset_session":
        return threads.handleResetSession(
          request.payload,
          request.id,
          request.createdAt,
          request.executionAttempts > 1,
        );
      case "abort_thread":
        return handleAbortThread(request.payload, request.id, request.executionAttempts > 1);
      case "compact_thread":
        return handleCompactThread(request.payload, request.id, signal);
      case "compact_session":
        return handleCompactSession(request.payload, request.id, signal);
      case "archive_session":
        return handleArchiveSession(request.payload, request.id);
      case "restore_session":
        return handleRestoreSession(request.payload);
      case "update_thread":
        return handleUpdateThread(request.payload, request.id, request.executionAttempts > 1);
      default:
        throw new Error(`Unsupported runtime request ${(request as {kind: string}).kind}.`);
    }
  };

  return async (request, signal): Promise<unknown> => {
    signal?.throwIfAborted();
    let result: unknown;
    try {
      result = await processRequest(request, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const committedInput = await recoverCommittedInput(request, true);
      if (committedInput) return committedInput;
      if (error instanceof RetryableRuntimeRequestError) throw error;
      if (error instanceof ThreadInputAdmissionBlockedError) {
        throw new RetryableRuntimeRequestError(
          `Runtime request ${request.id} is waiting for session ${error.sessionId} to finish reset.`,
          {cause: error},
        );
      }
      if (isRetryableRuntimeInfrastructureError(error)) {
        throw new RetryableRuntimeRequestError(
          `Runtime request ${request.id} lost access to required infrastructure.`,
          {cause: error},
        );
      }
      if (
        (request.executionAttempts ?? 1) <= 1
        && (
          request.kind === "abort_thread"
          || request.kind === "compact_thread"
          || request.kind === "compact_session"
          || request.kind === "archive_session"
          || request.kind === "restore_session"
          || request.kind === "create_branch_session"
          || request.kind === "create_subagent_session"
          || request.kind === "reset_session"
          || request.kind === "resolve_main_session_thread"
          || request.kind === "update_thread"
        )
      ) {
        throw new RetryableRuntimeRequestError(
          `Runtime request ${request.id} effect outcome is ambiguous and must be reconciled.`,
          {cause: error},
        );
      }
      throw error;
    }
    // Shutdown releases, rather than settles, the claim. Every mutating
    // handler above is replay-safe at its durable operation seam.
    signal?.throwIfAborted();
    return result;
  };
}
