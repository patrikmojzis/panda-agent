import type {
    CompleteOutboundDeliveryInput,
    CreateOutboundDeliveryInput,
    FailOutboundDeliveryInput,
    OutboundDeliveryNotification,
    OutboundDeliveryRecord,
    OutboundDeliveryWorkerLookup,
} from "./types.js";

export interface OutboundDeliveryStore {
  ensureSchema(): Promise<void>;
  enqueueDelivery(input: CreateOutboundDeliveryInput): Promise<OutboundDeliveryRecord>;
  getDelivery(id: string): Promise<OutboundDeliveryRecord>;
  claimNextPendingDelivery(lookup: OutboundDeliveryWorkerLookup): Promise<OutboundDeliveryRecord | null>;
  markDeliverySent(input: CompleteOutboundDeliveryInput): Promise<OutboundDeliveryRecord>;
  markDeliveryFailed(input: FailOutboundDeliveryInput): Promise<OutboundDeliveryRecord>;
  failSendingDeliveries(lookup: OutboundDeliveryWorkerLookup, error: string): Promise<number>;
  listenPendingDeliveries(
    listener: (notification: OutboundDeliveryNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
}
