import {randomUUID} from "node:crypto";

import type {JsonValue} from "../../kernel/agent/types.js";
import type {OutboundDeliveryRecord} from "../channels/deliveries/types.js";
import type {OutboundItem} from "../channels/types.js";
import type {A2ASenderEnvironmentSnapshot} from "../threads/requests/index.js";
import type {SessionStore} from "../sessions/index.js";
import {A2ASessionBindingRepo} from "./repo.js";
import {
    A2A_CONNECTOR_KEY,
    A2A_SOURCE,
    DEFAULT_A2A_MAX_MESSAGES_PER_HOUR
} from "../../integrations/channels/a2a/config.js";

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

export interface QueueA2AMessageInput {
  senderAgentKey: string;
  senderSessionId: string;
  senderThreadId: string;
  senderRunId?: string;
  agentKey?: string;
  sessionId?: string;
  senderEnvironment?: A2ASenderEnvironmentSnapshot;
  items: readonly OutboundItem[];
}

export interface QueueA2AMessageResult {
  delivery: OutboundDeliveryRecord;
  targetAgentKey: string;
  targetSessionId: string;
  messageId: string;
}

export interface A2AMessagingServiceOptions {
  bindings: A2ASessionBindingRepo;
  outboundDeliveries: OutboundDeliveryQueue;
  sessions: SessionStore;
  maxMessagesPerHour?: number;
}

function trimNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
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

export class A2AMessagingService {
  private readonly bindings: A2ASessionBindingRepo;
  private readonly outboundDeliveries: OutboundDeliveryQueue;
  private readonly sessions: SessionStore;
  private readonly maxMessagesPerHour: number;

  constructor(options: A2AMessagingServiceOptions) {
    this.bindings = options.bindings;
    this.outboundDeliveries = options.outboundDeliveries;
    this.sessions = options.sessions;
    this.maxMessagesPerHour = normalizePositiveInteger(options.maxMessagesPerHour);
  }

  async queueMessage(input: QueueA2AMessageInput): Promise<QueueA2AMessageResult> {
    const explicitSessionId = trimNonEmptyString(input.sessionId);
    const explicitAgentKey = trimNonEmptyString(input.agentKey);
    if (!explicitSessionId && !explicitAgentKey) {
      throw new Error("message_agent requires agentKey or sessionId.");
    }

    const targetSession = explicitSessionId
      ? await this.sessions.getSession(explicitSessionId)
      : await this.resolveMainSession(explicitAgentKey!);
    if (explicitAgentKey && targetSession.agentKey !== explicitAgentKey) {
      throw new Error(`Session ${targetSession.id} belongs to ${targetSession.agentKey}, not ${explicitAgentKey}.`);
    }

    if (targetSession.id === input.senderSessionId) {
      throw new Error("message_agent does not allow sending to the same session.");
    }

    const allowed = await this.bindings.hasBinding({
      senderSessionId: input.senderSessionId,
      recipientSessionId: targetSession.id,
    });
    if (!allowed) {
      throw new Error(`A2A is not allowed from ${input.senderSessionId} to ${targetSession.id}.`);
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
          ...(input.senderEnvironment ? {senderEnvironment: input.senderEnvironment as unknown as JsonValue} : {}),
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
