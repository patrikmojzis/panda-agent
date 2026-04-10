import type {RememberedRoute} from "../channels/core/types.js";

export type HomeThreadLastRoutes = Record<string, RememberedRoute>;

export interface HomeThreadMetadata {
  lastRoutes?: HomeThreadLastRoutes;
  homeDir?: string;
}

export interface HomeThreadLookup {
  identityId: string;
  agentKey: string;
}

export interface HomeThreadBindingInput extends HomeThreadLookup {
  threadId: string;
  metadata?: HomeThreadMetadata;
}

export interface HomeThreadRecord extends HomeThreadBindingInput {
  createdAt: number;
  updatedAt: number;
}

export interface BindHomeThreadResult {
  binding: HomeThreadRecord;
  previousThreadId?: string;
}

export interface RememberHomeThreadRouteInput extends HomeThreadLookup {
  route: RememberedRoute;
}
