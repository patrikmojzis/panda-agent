export interface HomeThreadMetadata {
  homeDir?: string;
}

export const DEFAULT_HOME_THREAD_HEARTBEAT_EVERY_MINUTES = 30;

export interface HomeThreadHeartbeatState {
  enabled: boolean;
  everyMinutes: number;
  nextFireAt: number;
  lastFireAt?: number;
  lastSkipReason?: string;
  claimedAt?: number;
  claimedBy?: string;
  claimExpiresAt?: number;
}

export interface HomeThreadLookup {
  identityId: string;
}

export interface HomeThreadBindingInput extends HomeThreadLookup {
  threadId: string;
  metadata?: HomeThreadMetadata;
}

export interface HomeThreadRecord extends HomeThreadBindingInput {
  heartbeat: HomeThreadHeartbeatState;
  createdAt: number;
  updatedAt: number;
}

export interface BindHomeThreadResult {
  binding: HomeThreadRecord;
  previousThreadId?: string;
}

export interface ListDueHomeThreadHeartbeatsInput {
  asOf?: number;
  limit?: number;
}

export interface ClaimHomeThreadHeartbeatInput extends HomeThreadLookup {
  claimedBy: string;
  claimExpiresAt: number;
  asOf?: number;
}

export interface RecordHomeThreadHeartbeatResultInput extends HomeThreadLookup {
  claimedBy: string;
  nextFireAt: number;
  lastFireAt?: number;
  lastSkipReason?: string | null;
}

export interface UpdateHomeThreadHeartbeatConfigInput extends HomeThreadLookup {
  enabled?: boolean;
  everyMinutes?: number;
  asOf?: number;
}
