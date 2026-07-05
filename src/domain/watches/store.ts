import type {
    ClaimWatchInput,
    ClaimWatchResult,
    CompleteWatchRunInput,
    CreateWatchInput,
    DisableWatchInput,
    FailWatchRunInput,
    ListDueWatchesInput,
    ListWatchRunsInput,
    ListWatchesInput,
    RecordWatchEventInput,
    StartWatchRunInput,
    UpdateWatchInput,
    WatchEventRecord,
    WatchRecord,
    WatchRunHistoryRecord,
    WatchRunRecord,
} from "./types.js";

export interface RecordWatchEventResult {
  event: WatchEventRecord;
  created: boolean;
}

export interface WatchStore {
  ensureSchema(): Promise<void>;
  createWatch(input: CreateWatchInput): Promise<WatchRecord>;
  updateWatch(input: UpdateWatchInput): Promise<WatchRecord>;
  disableWatch(input: DisableWatchInput): Promise<WatchRecord>;
  getWatch(watchId: string): Promise<WatchRecord>;
  listWatches(input: ListWatchesInput): Promise<readonly WatchRecord[]>;
  listDueWatches(input?: ListDueWatchesInput): Promise<readonly WatchRecord[]>;
  claimWatch(input: ClaimWatchInput): Promise<ClaimWatchResult | null>;
  startWatchRun(input: StartWatchRunInput): Promise<WatchRunRecord>;
  completeWatchRun(input: CompleteWatchRunInput): Promise<WatchRunRecord>;
  failWatchRun(input: FailWatchRunInput): Promise<WatchRunRecord>;
  clearWatchClaim(watchId: string): Promise<WatchRecord>;
  recordEvent(input: RecordWatchEventInput): Promise<RecordWatchEventResult>;
  getLatestWatchRun(watchId: string): Promise<WatchRunRecord | null>;
  listWatchRuns(input: ListWatchRunsInput): Promise<readonly WatchRunHistoryRecord[]>;
}
