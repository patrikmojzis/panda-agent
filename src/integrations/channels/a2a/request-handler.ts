import type {A2AMessageRequestPayload} from "../../../domain/threads/requests/types.js";
import type {SessionStore} from "../../../domain/sessions/store.js";
import {submitCurrentSessionInput} from "../../../domain/sessions/current-thread.js";
import type {ThreadRuntimeCoordinator} from "../../../domain/threads/runtime/coordinator.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {A2A_SOURCE} from "../../../domain/a2a/constants.js";
import {buildA2AInboundPersistence, buildA2AInboundText} from "./helpers.js";

export interface A2AInboundRequestBindings {
  hasBinding(input: {
    senderSessionId: string;
    recipientSessionId: string;
  }): Promise<boolean>;
  hasReceivedMessage(input: {
    recipientSessionId: string;
    senderSessionId: string;
    messageId: string;
  }): Promise<boolean>;
}

export interface A2AInboundRequestHandlerOptions {
  bindings: A2AInboundRequestBindings;
  coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
  sessions: Pick<SessionStore, "getSession">;
}

export async function handleA2AMessageRequest(
  payload: A2AMessageRequestPayload,
  options: A2AInboundRequestHandlerOptions,
): Promise<Record<string, unknown>> {
  const allowed = await options.bindings.hasBinding({
    senderSessionId: payload.fromSessionId,
    recipientSessionId: payload.toSessionId,
  });
  if (!allowed) {
    return {status: "dropped", reason: "unbound_session_pair"};
  }

  const session = await options.sessions.getSession(payload.toSessionId);
  if (session.agentKey !== payload.toAgentKey) {
    return {status: "dropped", reason: "recipient_session_agent_mismatch"};
  }
  const duplicate = await options.bindings.hasReceivedMessage({
    recipientSessionId: payload.toSessionId,
    senderSessionId: payload.fromSessionId,
    messageId: payload.externalMessageId,
  });
  if (duplicate) {
    return {status: "dropped", reason: "duplicate_message"};
  }

  const persistence = buildA2AInboundPersistence(payload);
  const {threadId} = await submitCurrentSessionInput({
    sessions: options.sessions,
    sessionId: session.id,
    coordinator: options.coordinator,
    payload: {
      source: A2A_SOURCE,
      channelId: payload.fromSessionId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.fromAgentKey,
      message: stringToUserMessage(buildA2AInboundText(payload)),
      metadata: persistence.metadata,
    },
  });
  return {status: "queued", threadId};
}
