export interface A2ASessionBindingLookup {
  senderSessionId: string;
  recipientSessionId: string;
}

export interface BindA2ASessionInput extends A2ASessionBindingLookup {}

export interface A2ASessionBindingRecord extends A2ASessionBindingLookup {
  createdAt: number;
  updatedAt: number;
}

export interface ListA2ASessionBindingsInput {
  senderSessionId?: string;
  recipientSessionId?: string;
}

export interface CountRecentA2AMessagesInput extends A2ASessionBindingLookup {
  since: number;
}

export type A2ADeliveryDirection = "inbound" | "outbound";

export interface A2ADeliveryItemSummary {
  type: "text" | "image" | "file";
  textPreview?: string;
  path?: string;
  filename?: string;
}

export interface A2ADeliverySentItemSummary {
  type: "text" | "image" | "file";
  externalMessageId: string;
}

export interface A2ADeliveryRecord {
  deliveryId: string;
  messageId: string;
  fromAgentKey: string;
  fromSessionId: string;
  fromThreadId: string;
  fromRunId?: string;
  toAgentKey: string;
  toSessionId: string;
  direction: A2ADeliveryDirection;
  status: "pending" | "sending" | "sent" | "failed";
  attemptCount: number;
  lastError?: string;
  itemCount: number;
  items: readonly A2ADeliveryItemSummary[];
  sentItems?: readonly A2ADeliverySentItemSummary[];
  sentAt: number;
  claimedAt?: number;
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface GetA2ADeliveryInput {
  sessionId: string;
  deliveryId: string;
}

export interface ListA2ADeliveriesInput {
  sessionId: string;
  peerSessionId?: string;
  direction?: A2ADeliveryDirection | "all";
  limit?: number;
}
