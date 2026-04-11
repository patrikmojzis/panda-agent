import type {
    ChannelActionNotification,
    ChannelActionRecord,
    ChannelActionWorkerLookup,
    CreateChannelActionInput,
} from "./types.js";

export interface ChannelActionStore {
  ensureSchema(): Promise<void>;
  enqueueAction(input: CreateChannelActionInput): Promise<ChannelActionRecord>;
  claimNextPendingAction(lookup: ChannelActionWorkerLookup): Promise<ChannelActionRecord | null>;
  markActionSent(id: string): Promise<ChannelActionRecord>;
  markActionFailed(id: string, error: string): Promise<ChannelActionRecord>;
  failSendingActions(lookup: ChannelActionWorkerLookup, error: string): Promise<number>;
  listenPendingActions(
    listener: (notification: ChannelActionNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
}
