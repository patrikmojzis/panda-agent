import type {A2AMessageRequestPayload} from "../../../domain/threads/requests/types.js";
import type {MediaDescriptor} from "../../../domain/channels/types.js";
import type {SessionStore} from "../../../domain/sessions/store.js";
import type {ThreadRuntimeCoordinator} from "../../../domain/threads/runtime/coordinator.js";
import type {ThreadEnqueueOptions} from "../../../domain/threads/runtime/types.js";
import {stringToUserMessage} from "../../../kernel/agent/helpers/input.js";
import {A2A_SOURCE} from "../../../domain/a2a/constants.js";
import {buildA2AInboundPersistence, buildA2AInboundText} from "./helpers.js";
import {submitDurableRuntimeRequestInput} from "../inbound-delivery.js";

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
  coordinator: Pick<ThreadRuntimeCoordinator, "submitSessionInput">;
  enqueueOptions?: ThreadEnqueueOptions;
  sessions: Pick<SessionStore, "getSession">;
  relocateAgentMedia(agentKey: string, media: readonly MediaDescriptor[]): Promise<readonly MediaDescriptor[]>;
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

  const stagedMedia = payload.items.flatMap((item) => item.type === "text" ? [] : [item.media]);
  const relocatedMedia = await options.relocateAgentMedia(session.agentKey, stagedMedia);
  if (relocatedMedia.length !== stagedMedia.length) {
    throw new Error("A2A media relocation returned an invalid descriptor count.");
  }
  let mediaIndex = 0;
  const localizedPayload: A2AMessageRequestPayload = {
    ...payload,
    items: payload.items.map((item) => {
      if (item.type === "text") return item;
      const media = relocatedMedia[mediaIndex++];
      if (!media) throw new Error("A2A media relocation omitted a descriptor.");
      return {...item, media};
    }),
  };
  const persistence = buildA2AInboundPersistence(localizedPayload);
  const {threadId} = await submitDurableRuntimeRequestInput({
    sessionId: session.id,
    coordinator: options.coordinator,
    ...(options.enqueueOptions === undefined ? {} : {enqueueOptions: options.enqueueOptions}),
    payload: {
      source: A2A_SOURCE,
      channelId: payload.fromSessionId,
      externalMessageId: payload.externalMessageId,
      actorId: payload.fromAgentKey,
      message: stringToUserMessage(buildA2AInboundText(localizedPayload)),
      metadata: persistence.metadata,
    },
  });
  return {status: "queued", threadId};
}
