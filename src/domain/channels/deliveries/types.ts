import type {JsonValue} from "../../../kernel/agent/types.js";
import type {OutboundItem, OutboundSentItem, OutboundTarget,} from "../types.js";

export type OutboundDeliveryStatus = "pending" | "sending" | "sent" | "failed";

export interface DeliveryNotification {
  channel: string;
  connectorKey: string;
}

export interface DeliveryWorkerLookup {
  channel: string;
  connectorKey: string;
}

export interface OutboundDeliveryInput {
  threadId?: string;
  channel: string;
  target: OutboundTarget;
  items: readonly OutboundItem[];
  metadata?: JsonValue;
}

export interface OutboundDeliveryRecord extends OutboundDeliveryInput {
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

export interface CompleteDeliveryInput {
  id: string;
  sent: readonly OutboundSentItem[];
}

export interface FailDeliveryInput {
  id: string;
  error: string;
}
