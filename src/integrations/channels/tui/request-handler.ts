import type {SessionRouteRepo} from "../../../domain/sessions/routes/repo.js";
import type {SessionStore} from "../../../domain/sessions/store.js";
import type {TuiInputRequestPayload} from "../../../domain/threads/requests/types.js";
import type {ThreadRuntimeCoordinator} from "../../../domain/threads/runtime/coordinator.js";
import type {ThreadRecord} from "../../../domain/threads/runtime/types.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {submitRememberedChannelInput} from "../inbound-delivery.js";
import {
  buildTuiInboundPersistence,
  buildTuiInboundText,
  TUI_CONVERSATION_ID,
  TUI_SOURCE,
} from "./helpers.js";

export interface TuiInboundRequestHandlerOptions {
  coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  routes: Pick<SessionRouteRepo, "saveLastRoute">;
  sessions: Pick<SessionStore, "getSession">;
}

export async function handleTuiInputRequest(
  payload: TuiInputRequestPayload,
  identityId: string,
  thread: ThreadRecord,
  options: TuiInboundRequestHandlerOptions,
): Promise<Record<string, unknown>> {
  const sentAt = payload.sentAt ? new Date(payload.sentAt).toISOString() : undefined;
  const persistence = buildTuiInboundPersistence({
    sentAt,
    actorId: payload.actorId,
    externalMessageId: payload.externalMessageId,
  });

  const target = await submitRememberedChannelInput({
    coordinator: options.coordinator,
    routes: options.routes,
    sessions: options.sessions,
    sessionId: thread.sessionId,
    identityId,
    route: persistence.rememberedRoute,
    payload: {
      message: stringToUserMessage(buildTuiInboundText({
        actorId: payload.actorId,
        externalMessageId: payload.externalMessageId,
        identityHandle: payload.identityHandle,
        sentAt,
        body: payload.text,
      })),
      source: TUI_SOURCE,
      channelId: TUI_CONVERSATION_ID,
      externalMessageId: payload.externalMessageId,
      actorId: payload.actorId,
      identityId,
      metadata: persistence.metadata,
    },
  });
  return {status: "queued", threadId: target.threadId};
}
