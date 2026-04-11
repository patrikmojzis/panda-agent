import type {
    BindHomeThreadResult,
    ClaimHomeThreadHeartbeatInput,
    HomeThreadBindingInput,
    HomeThreadLookup,
    HomeThreadRecord,
    ListDueHomeThreadHeartbeatsInput,
    RecordHomeThreadHeartbeatResultInput,
    UpdateHomeThreadHeartbeatConfigInput,
} from "./types.js";

export interface HomeThreadStore {
  resolveHomeThread(lookup: HomeThreadLookup): Promise<HomeThreadRecord | null>;
  bindHomeThread(input: HomeThreadBindingInput): Promise<BindHomeThreadResult>;
  listDueHeartbeats(input?: ListDueHomeThreadHeartbeatsInput): Promise<readonly HomeThreadRecord[]>;
  claimHeartbeat(input: ClaimHomeThreadHeartbeatInput): Promise<HomeThreadRecord | null>;
  recordHeartbeatResult(input: RecordHomeThreadHeartbeatResultInput): Promise<HomeThreadRecord>;
  updateHeartbeatConfig(input: UpdateHomeThreadHeartbeatConfigInput): Promise<HomeThreadRecord>;
}
