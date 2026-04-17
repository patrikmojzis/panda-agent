import type {WatchEvaluator} from "./runner.js";
import type {WatchStore} from "./store.js";
import type {CreateWatchInput, UpdateWatchInput, WatchRecord,} from "./types.js";
import {validateWatchSourcePaths} from "./path-validation.js";

const CREATE_PREVIEW_WATCH_ID = "watch-create-preview";

export interface WatchMutationScope {
  agentKey: string;
  sessionId: string;
  createdByIdentityId?: string;
}

export interface CreateWatchMutationInput extends Omit<CreateWatchInput, "sessionId" | "createdByIdentityId" | "state" | "nextPollAt"> {}

export interface UpdateWatchMutationInput extends Omit<UpdateWatchInput, "sessionId" | "state" | "nextPollAt"> {}

export interface WatchMutationServiceOptions {
  store: WatchStore;
  evaluateWatch: WatchEvaluator;
}

function buildCredentialScope(scope: WatchMutationScope): {
  agentKey: string;
  identityId?: string;
} {
  return {
    agentKey: scope.agentKey,
    identityId: scope.createdByIdentityId,
  };
}

function buildCreateCandidate(
  input: CreateWatchMutationInput,
  scope: WatchMutationScope,
): WatchRecord {
  const now = Date.now();
  return {
    id: CREATE_PREVIEW_WATCH_ID,
    sessionId: scope.sessionId,
    createdByIdentityId: scope.createdByIdentityId,
    title: input.title,
    intervalMinutes: input.intervalMinutes,
    source: input.source,
    detector: input.detector,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

function buildUpdateCandidate(
  existing: WatchRecord,
  input: UpdateWatchMutationInput,
): {
  candidate: WatchRecord;
  resetState: boolean;
  enabled: boolean;
} {
  const resetState = input.source !== undefined || input.detector !== undefined;
  const enabled = input.enabled ?? existing.enabled;
  return {
    candidate: {
      ...existing,
      title: input.title ?? existing.title,
      intervalMinutes: input.intervalMinutes ?? existing.intervalMinutes,
      source: input.source ?? existing.source,
      detector: input.detector ?? existing.detector,
      enabled,
      state: resetState ? undefined : existing.state,
    },
    resetState,
    enabled,
  };
}

function ensureSessionAccess(watch: WatchRecord, sessionId: string): WatchRecord {
  if (watch.sessionId !== sessionId) {
    throw new Error(`Unknown watch ${watch.id}`);
  }

  return watch;
}

export class WatchMutationService {
  private readonly store: WatchStore;
  private readonly evaluateWatchFn: WatchEvaluator;

  constructor(options: WatchMutationServiceOptions) {
    this.store = options.store;
    this.evaluateWatchFn = options.evaluateWatch;
  }

  async createWatch(
    input: CreateWatchMutationInput,
    scope: WatchMutationScope,
  ): Promise<WatchRecord> {
    const candidate = buildCreateCandidate(input, scope);
    validateWatchSourcePaths(candidate.source);
    const evaluation = await this.evaluateWatchFn(candidate, buildCredentialScope(scope));
    const seedEnabled = candidate.enabled;
    const nextPollAt = seedEnabled
      ? Date.now() + candidate.intervalMinutes * 60_000
      : null;

    return await this.store.createWatch({
      sessionId: scope.sessionId,
      createdByIdentityId: scope.createdByIdentityId,
      title: candidate.title,
      intervalMinutes: candidate.intervalMinutes,
      source: candidate.source,
      detector: candidate.detector,
      enabled: candidate.enabled,
      state: seedEnabled ? evaluation.nextState : undefined,
      nextPollAt,
    });
  }

  async updateWatch(
    input: UpdateWatchMutationInput,
    scope: WatchMutationScope,
  ): Promise<WatchRecord> {
    const existing = ensureSessionAccess(await this.store.getWatch(input.watchId), scope.sessionId);
    const {candidate, resetState, enabled} = buildUpdateCandidate(existing, input);
    validateWatchSourcePaths(candidate.source);
    const evaluation = await this.evaluateWatchFn(candidate, buildCredentialScope(scope));

    const nextPollAt = resetState && enabled
      ? Date.now() + candidate.intervalMinutes * 60_000
      : undefined;
    const nextState = resetState
      ? (enabled ? evaluation.nextState : null)
      : undefined;

    return await this.store.updateWatch({
      watchId: input.watchId,
      sessionId: scope.sessionId,
      title: input.title,
      intervalMinutes: input.intervalMinutes,
      source: input.source,
      detector: input.detector,
      enabled: input.enabled,
      state: nextState,
      nextPollAt,
    });
  }
}
