import type {
  AbortThreadRequestPayload,
  CompactThreadRequestPayload,
  CreateBranchSessionRequestPayload,
  CreateSubagentSessionRequestPayload,
  ResolveThreadRunConfigRequestPayload,
  RuntimeRequestRecord,
  TuiInputRequestPayload,
  UpdateThreadRequestPayload,
} from "../../domain/threads/requests/types.js";
import {compactThread} from "../../kernel/transcript/compaction.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {IdentityStore} from "../../domain/identity/store.js";
import type {SessionRouteRepo} from "../../domain/sessions/routes/repo.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {handleA2AMessageRequest} from "../../integrations/channels/a2a/request-handler.js";
import {handleDiscordMessageRequest} from "../../integrations/channels/discord/request-handler.js";
import {
  handleTelegramReactionRequest,
  handleTelegramRuntimeMessageRequest,
} from "../../integrations/channels/telegram/request-handler.js";
import {handleTuiInputRequest} from "../../integrations/channels/tui/request-handler.js";
import {
  handleWhatsAppMessageRequest,
  handleWhatsAppReactionRequest,
} from "../../integrations/channels/whatsapp/request-handler.js";
import {readMissingApiKeyMessageForModel} from "../../integrations/providers/shared/missing-api-key.js";
import type {DaemonThreadHelpers} from "./daemon-threads.js";
import {readSubagentSessionMetadata} from "../../domain/subagents/session-metadata.js";
import {requireIdentityId} from "./daemon-shared.js";

export const UNSUPPORTED_CREATE_WORKER_SESSION_REQUEST_ERROR = "Unsupported runtime request create_worker_session after subagent hard cut.";

export interface DaemonRequestProcessorContext {
  runtime: {
    coordinator: Pick<
      ThreadRuntimeCoordinator,
      "abort" | "resolveThreadRunConfig" | "runExclusively" | "submitInput"
    >;
    identityStore: Pick<IdentityStore, "getIdentity" | "resolveIdentityBinding">;
    sessionStore: Pick<SessionStore, "getSession" | "updateSessionRuntimeConfig">;
    store: DaemonRequestStore;
  };
  a2aBindings: Parameters<typeof handleA2AMessageRequest>[1]["bindings"];
  sessionRoutes: Pick<SessionRouteRepo, "saveLastRoute">;
}

type DaemonRequestStore = Pick<
  ThreadRuntimeStore,
  "appendRuntimeMessage" | "getThread" | "hasRunnableInputs" | "loadTranscript" | "updateThread"
>;

export type DaemonRequestThreadHelpers = Pick<
  DaemonThreadHelpers,
  | "createBranchSession"
  | "createSubagentSession"
  | "ensureIdentity"
  | "handleResetSession"
  | "openMainSession"
  | "queueSystemReply"
  | "relocateThreadMedia"
  | "resolveBoundConversationThread"
  | "resolveOrCreateConversationThread"
>;

export function createDaemonRequestProcessor(
  context: DaemonRequestProcessorContext,
  threads: DaemonRequestThreadHelpers,
): (request: RuntimeRequestRecord) => Promise<unknown> {
  const handleTuiInput = async (
    payload: TuiInputRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const identityId = requireIdentityId(payload.identityId, "tui_input");
    const thread = payload.threadId
      ? await context.runtime.store.getThread(payload.threadId)
      : await threads.openMainSession({
        identityId,
      });

    return handleTuiInputRequest(payload, identityId, thread, {
      coordinator: context.runtime.coordinator,
      routes: context.sessionRoutes,
      sessions: context.runtime.sessionStore,
    });
  };

  const handleCreateBranchSession = async (
    payload: CreateBranchSessionRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const identity = await threads.ensureIdentity(requireIdentityId(payload.identityId, "create_branch_session"));
    const thread = await threads.createBranchSession({
      identity,
      sessionId: payload.sessionId,
      agentKey: payload.agentKey,
      model: payload.model,
      thinking: payload.thinking,
      inferenceProjection: payload.inferenceProjection,
    });
    return {threadId: thread.id};
  };

  const handleCreateSubagentSession = async (
    payload: CreateSubagentSessionRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const identity = await threads.ensureIdentity(requireIdentityId(payload.identityId, "create_subagent_session"));
    const created = await threads.createSubagentSession({
      identity,
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
            networkPolicy: created.environment.networkPolicy,
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
  ): Promise<Record<string, unknown>> => {
    const aborted = await context.runtime.coordinator.abort(payload.threadId, payload.reason);
    return {aborted};
  };

  const handleCompactThread = async (
    payload: CompactThreadRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const compacted = await context.runtime.coordinator.runExclusively(payload.threadId, async () => {
      const thread = await context.runtime.store.getThread(payload.threadId);
      const runConfig = await context.runtime.coordinator.resolveThreadRunConfig(thread);
      const modelName = runConfig.model;
      const apiKeyMessage = readMissingApiKeyMessageForModel(modelName);
      if (apiKeyMessage) {
        throw new Error(apiKeyMessage);
      }

      if (await context.runtime.store.hasRunnableInputs(payload.threadId)) {
        throw new Error("Wait for queued input to run before compacting.");
      }

      return compactThread({
        store: context.runtime.store,
        thread,
        model: modelName,
        thinking: runConfig.thinking,
        customInstructions: payload.customInstructions,
        trigger: "manual",
      });
    });

    if (!compacted) {
      return {compacted: false};
    }

    return {
      compacted: true,
      tokensBefore: compacted.tokensBefore,
      tokensAfter: compacted.tokensAfter,
    };
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

  const handleUpdateThread = async (
    payload: UpdateThreadRequestPayload,
  ): Promise<Record<string, unknown>> => {
    const {model, thinking, inferenceProjection, pendingWakeAt, runtimeState} = payload.update;
    const threadUpdate = {
      ...(runtimeState !== undefined ? {runtimeState} : {}),
    };
    const existingThread = await context.runtime.store.getThread(payload.threadId);
    if (model !== undefined || thinking !== undefined || inferenceProjection !== undefined || pendingWakeAt !== undefined) {
      await context.runtime.sessionStore.updateSessionRuntimeConfig({
        sessionId: existingThread.sessionId,
        ...(model !== undefined ? {model} : {}),
        ...(thinking !== undefined ? {thinking} : {}),
        ...(inferenceProjection !== undefined ? {inferenceProjection} : {}),
        ...(pendingWakeAt !== undefined ? {pendingWakeAt} : {}),
      });
    }

    const thread = Object.keys(threadUpdate).length > 0
      ? await context.runtime.store.updateThread(payload.threadId, threadUpdate)
      : existingThread;
    return {threadId: thread.id};
  };

  return async (request: RuntimeRequestRecord): Promise<unknown> => {
    switch (request.kind) {
      case "a2a_message":
        return handleA2AMessageRequest(request.payload, {
          bindings: context.a2aBindings,
          coordinator: context.runtime.coordinator,
          sessions: context.runtime.sessionStore,
        });
      case "discord_message":
        return handleDiscordMessageRequest(request.payload, {
          coordinator: context.runtime.coordinator,
          identityStore: context.runtime.identityStore,
          routes: context.sessionRoutes,
          sessions: context.runtime.sessionStore,
          threads,
        });
      case "telegram_message":
        return handleTelegramRuntimeMessageRequest(request.payload, {
          coordinator: context.runtime.coordinator,
          identityStore: context.runtime.identityStore,
          routes: context.sessionRoutes,
          sessions: context.runtime.sessionStore,
          threads,
        });
      case "telegram_reaction":
        return handleTelegramReactionRequest(request.payload, {
          coordinator: context.runtime.coordinator,
          identityStore: context.runtime.identityStore,
          routes: context.sessionRoutes,
          sessions: context.runtime.sessionStore,
          threads,
        });
      case "whatsapp_message":
        return handleWhatsAppMessageRequest(request.payload, {
          coordinator: context.runtime.coordinator,
          identityStore: context.runtime.identityStore,
          routes: context.sessionRoutes,
          sessions: context.runtime.sessionStore,
          threads,
        });
      case "whatsapp_reaction":
        return handleWhatsAppReactionRequest(request.payload, {
          coordinator: context.runtime.coordinator,
          identityStore: context.runtime.identityStore,
          routes: context.sessionRoutes,
          sessions: context.runtime.sessionStore,
          threads,
        });
      case "tui_input":
        return handleTuiInput(request.payload);
      case "create_branch_session":
        return handleCreateBranchSession(request.payload);
      case "create_subagent_session":
        return handleCreateSubagentSession(request.payload);
      case "create_worker_session":
        throw new Error(UNSUPPORTED_CREATE_WORKER_SESSION_REQUEST_ERROR);
      case "resolve_main_session_thread": {
        const thread = await threads.openMainSession(
          request.payload,
        );
        return {threadId: thread.id};
      }
      case "resolve_thread_run_config":
        return handleResolveThreadRunConfig(request.payload);
      case "reset_session":
        return threads.handleResetSession(request.payload);
      case "abort_thread":
        return handleAbortThread(request.payload);
      case "compact_thread":
        return handleCompactThread(request.payload);
      case "update_thread":
        return handleUpdateThread(request.payload);
      default:
        throw new Error(`Unsupported runtime request ${(request as {kind: string}).kind}.`);
    }
  };
}
