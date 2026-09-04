import type {
    ClaimWatchInput,
    ClaimWatchResult,
    AcceptWatchEvaluationInput,
    RenewWatchClaimInput,
    CreateWatchInput,
    DisableWatchInput,
    FailWatchRunInput,
    ListDueWatchesInput,
    ListWatchRunsInput,
    ListWatchesInput,
    StartWatchRunInput,
    UpdateWatchInput,
    WatchRecord,
    WatchRunHistoryRecord,
    WatchRunRecord,
} from "./types.js";

export interface WatchStore {
  createWatch(input: CreateWatchInput): Promise<WatchRecord>;
  updateWatch(input: UpdateWatchInput): Promise<WatchRecord>;
  disableWatch(input: DisableWatchInput): Promise<WatchRecord>;
  getWatch(watchId: string): Promise<WatchRecord>;
  listWatches(input: ListWatchesInput): Promise<readonly WatchRecord[]>;
  listDueWatches(input?: ListDueWatchesInput): Promise<readonly WatchRecord[]>;
  claimWatch(input: ClaimWatchInput): Promise<ClaimWatchResult | null>;
  startWatchRun(input: StartWatchRunInput): Promise<WatchRunRecord | null>;
  renewWatchClaim(input: RenewWatchClaimInput): Promise<boolean>;
  acceptWatchEvaluation(input: AcceptWatchEvaluationInput): Promise<WatchRunRecord | null>;
  failWatchRun(input: FailWatchRunInput): Promise<WatchRunRecord | null>;
  getLatestWatchRun(watchId: string): Promise<WatchRunRecord | null>;
  listWatchRuns(input: ListWatchRunsInput): Promise<readonly WatchRunHistoryRecord[]>;
}
