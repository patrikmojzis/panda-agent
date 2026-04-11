import type {JsonValue} from "../../../kernel/agent/types.js";
import type {OutboundItem, OutboundSentItem, OutboundTarget,} from "../types.js";

export type OutboundDeliveryStatus = "pending" | "sending" | "sent" | "failed";

export interface OutboundDeliveryNotification {
  channel: string;
  connectorKey: string;
}

export interface OutboundDeliveryWorkerLookup {
  channel: string;
  connectorKey: string;
}

export interface CreateOutboundDeliveryInput {
  threadId?: string;
  channel: string;
  target: OutboundTarget;
  items: readonly OutboundItem[];
  metadata?: JsonValue;
}

export interface OutboundDeliveryRecord extends CreateOutboundDeliveryInput {
  id: string;
  status: OutboundDeliveryStatus;
  attemptCount: number;
  lastError?: string;
  sent?: readonly OutboundSentItem[];
  claimedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface CompleteOutboundDeliveryInput {
  id: string;
  sent: readonly OutboundSentItem[];
}

export interface FailOutboundDeliveryInput {
  id: string;
  error: string;
}
