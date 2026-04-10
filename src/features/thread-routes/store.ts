import type {RememberedRoute} from "../channels/core/types.js";
import type {RememberThreadRouteInput, ThreadRouteLookup, ThreadRouteRecord} from "./types.js";

export interface ThreadRouteStore {
  ensureSchema(): Promise<void>;
  resolveLastRoute(lookup: ThreadRouteLookup): Promise<RememberedRoute | null>;
  rememberLastRoute(input: RememberThreadRouteInput): Promise<ThreadRouteRecord>;
}
