import type {
    CompleteDeliveryInput,
    DeliveryNotification,
    DeliveryWorkerLookup,
    FailDeliveryInput,
    OutboundDeliveryInput,
    OutboundDeliveryRecord,
} from "./types.js";

export interface OutboundDeliveryStore {
  ensureSchema(): Promise<void>;
  enqueueDelivery(input: OutboundDeliveryInput): Promise<OutboundDeliveryRecord>;
  getDelivery(id: string): Promise<OutboundDeliveryRecord>;
  claimNextPendingDelivery(lookup: DeliveryWorkerLookup): Promise<OutboundDeliveryRecord | null>;
  markDeliverySent(input: CompleteDeliveryInput): Promise<OutboundDeliveryRecord>;
  markDeliveryFailed(input: FailDeliveryInput): Promise<OutboundDeliveryRecord>;
  failSendingDeliveries(lookup: DeliveryWorkerLookup, error: string): Promise<number>;
  listenPendingDeliveries(
    listener: (notification: DeliveryNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
}
