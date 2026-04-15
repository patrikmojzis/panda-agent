import type {RememberedRoute} from "../../../domain/channels/types.js";

export interface SessionRouteLookup {
  sessionId: string;
  identityId?: string;
  channel?: string;
}

export interface SessionRouteInput {
  sessionId: string;
  identityId?: string;
  route: RememberedRoute;
}

export interface SessionRouteRecord extends SessionRouteInput {
  channel: string;
  createdAt: number;
  updatedAt: number;
}
