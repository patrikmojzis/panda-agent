import {randomUUID} from "node:crypto";

import {isJsonObject, type JsonObject, type JsonValue} from "../../lib/json.js";
import {trimToUndefined} from "../../lib/strings.js";
import type {OutboundDeliveryRecord} from "../channels/deliveries/types.js";
import type {OutboundItem} from "../channels/types.js";
import {commandScopeDenied} from "../commands/errors.js";
import type {SessionStore} from "../sessions/store.js";
import type {A2ASenderEnvironmentSnapshot} from "../threads/requests/types.js";
import {
  A2A_CONNECTOR_KEY,
  A2A_SOURCE,
  DEFAULT_A2A_MAX_MESSAGES_PER_HOUR,
} from "./constants.js";

interface OutboundDeliveryQueue {
  enqueueDelivery(input: {
    threadId?: string;
    channel: string;
    target: {
      source: string;
      connectorKey: string;
      externalConversationId: string;
      externalActorId?: string;
      replyToMessageId?: string;
    };
    items: readonly OutboundItem[];
    metadata?: JsonValue;
  }): Promise<OutboundDeliveryRecord>;
}

interface A2AMessagingBindings {
  hasBinding(input: {
    senderSessionId: string;
    recipientSessionId: string;
  }): Promise<boolean>;
  countRecentMessages(input: {
    senderSessionId: string;
    recipientSessionId: string;
    since: number;
  }): Promise<number>;
}

interface QueueA2AMessageInput {
  senderAgentKey: string;
  senderSessionId: string;
  senderThreadId: string;
  senderRunId?: string;
  agentKey?: string;
  sessionId?: string;
  senderEnvironment?: A2ASenderEnvironmentSnapshot;
  items: readonly OutboundItem[];
}

interface QueueA2AMessageResult {
  delivery: OutboundDeliveryRecord;
  targetAgentKey: string;
  targetSessionId: string;
  messageId: string;
}

interface A2AMessagingServiceOptions {
  bindings: A2AMessagingBindings;
  outboundDeliveries: OutboundDeliveryQueue;
  sessions: Pick<SessionStore, "getMainSession" | "getSession">;
  maxMessagesPerHour?: number;
}

function normalizePositiveInteger(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) {
    return DEFAULT_A2A_MAX_MESSAGES_PER_HOUR;
  }

  return value;
}

function buildMessageId(): string {
  return `a2a:${randomUUID()}`;
}

function senderEnvironmentToJsonObject(value: A2ASenderEnvironmentSnapshot): JsonObject {
  if (isJsonObject(value)) {
    return value;
  }

  throw new Error("A2A sender environment metadata must be JSON-safe.");
}

export class A2AMessagingService {
  private readonly bindings: A2AMessagingBindings;
  private readonly outboundDeliveries: OutboundDeliveryQueue;
  private readonly sessions: Pick<SessionStore, "getMainSession" | "getSession">;
  private readonly maxMessagesPerHour: number;

  constructor(options: A2AMessagingServiceOptions) {
    this.bindings = options.bindings;
    this.outboundDeliveries = options.outboundDeliveries;
    this.sessions = options.sessions;
    this.maxMessagesPerHour = normalizePositiveInteger(options.maxMessagesPerHour);
  }

  async queueMessage(input: QueueA2AMessageInput): Promise<QueueA2AMessageResult> {
    const explicitSessionId = trimToUndefined(input.sessionId);
    const explicitAgentKey = trimToUndefined(input.agentKey);
    if (!explicitSessionId && !explicitAgentKey) {
      throw new Error("a2a.send requires agentKey or sessionId.");
    }

    const targetSession = explicitSessionId
      ? await this.sessions.getSession(explicitSessionId)
      : await this.resolveMainSession(explicitAgentKey!);
    if (explicitAgentKey && targetSession.agentKey !== explicitAgentKey) {
      throw commandScopeDenied(
        "The requested A2A target does not match the selected session.",
        "resource_scope_denied",
        "Use a target returned by the current A2A commands.",
      );
    }

    if (targetSession.id === input.senderSessionId) {
      throw new Error("a2a.send does not allow sending to the same session.");
    }

    const allowed = await this.bindings.hasBinding({
      senderSessionId: input.senderSessionId,
      recipientSessionId: targetSession.id,
    });
    if (!allowed) {
      throw commandScopeDenied(
        "A2A delivery is not allowed between these sessions.",
        "resource_scope_denied",
        "Use a currently bound A2A peer session.",
      );
    }

    const since = Date.now() - (60 * 60 * 1_000);
    const recentMessageCount = await this.bindings.countRecentMessages({
      senderSessionId: input.senderSessionId,
      recipientSessionId: targetSession.id,
      since,
    });
    if (recentMessageCount >= this.maxMessagesPerHour) {
      throw new Error(
        `A2A rate limit reached for ${input.senderSessionId} -> ${targetSession.id} (${this.maxMessagesPerHour}/hour).`,
      );
    }

    const messageId = buildMessageId();
    const sentAt = Date.now();
    const delivery = await this.outboundDeliveries.enqueueDelivery({
      threadId: input.senderThreadId,
      channel: A2A_SOURCE,
      target: {
        source: A2A_SOURCE,
        connectorKey: A2A_CONNECTOR_KEY,
        externalConversationId: targetSession.id,
        externalActorId: targetSession.agentKey,
      },
      items: input.items,
      metadata: {
        a2a: {
          messageId,
          fromAgentKey: input.senderAgentKey,
          fromSessionId: input.senderSessionId,
          fromThreadId: input.senderThreadId,
          fromRunId: input.senderRunId ?? null,
          toAgentKey: targetSession.agentKey,
          toSessionId: targetSession.id,
          sentAt,
          ...(input.senderEnvironment ? {senderEnvironment: senderEnvironmentToJsonObject(input.senderEnvironment)} : {}),
        },
      },
    });

    return {
      delivery,
      targetAgentKey: targetSession.agentKey,
      targetSessionId: targetSession.id,
      messageId,
    };
  }

  private async resolveMainSession(agentKey: string) {
    const session = await this.sessions.getMainSession(agentKey);
    if (!session) {
      throw new Error(`Agent ${agentKey} does not have a main session.`);
    }

    return session;
  }
}
