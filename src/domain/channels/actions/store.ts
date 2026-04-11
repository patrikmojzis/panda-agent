import type {ActionNotification, ActionWorkerLookup, ChannelActionInput, ChannelActionRecord,} from "./types.js";

export interface ChannelActionStore {
  ensureSchema(): Promise<void>;
  enqueueAction(input: ChannelActionInput): Promise<ChannelActionRecord>;
  claimNextPendingAction(lookup: ActionWorkerLookup): Promise<ChannelActionRecord | null>;
  markActionSent(id: string): Promise<ChannelActionRecord>;
  markActionFailed(id: string, error: string): Promise<ChannelActionRecord>;
  failSendingActions(lookup: ActionWorkerLookup, error: string): Promise<number>;
  listenPendingActions(
    listener: (notification: ActionNotification) => Promise<void> | void,
  ): Promise<() => Promise<void>>;
}
