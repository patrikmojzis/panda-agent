import type {RememberedRoute} from "../../../domain/channels/types.js";

export interface ThreadRouteLookup {
  threadId: string;
  channel?: string;
}

export interface RememberThreadRouteInput {
  threadId: string;
  route: RememberedRoute;
}

export interface ThreadRouteRecord extends RememberThreadRouteInput {
  channel: string;
  createdAt: number;
  updatedAt: number;
}
