import type {RememberedRoute} from "../../../domain/channels/types.js";

export interface ThreadRouteLookup {
  threadId: string;
  channel?: string;
}

export interface ThreadRouteInput {
  threadId: string;
  route: RememberedRoute;
}

export interface ThreadRouteRecord extends ThreadRouteInput {
  channel: string;
  createdAt: number;
  updatedAt: number;
}
