import type {
    BindHomeThreadResult,
    HomeThreadBindingInput,
    HomeThreadLookup,
    HomeThreadRecord,
    RememberHomeThreadRouteInput,
} from "./types.js";
import type {RememberedRoute} from "../channels/core/types.js";

export interface HomeThreadStore {
  resolveHomeThread(lookup: HomeThreadLookup): Promise<HomeThreadRecord | null>;
  bindHomeThread(input: HomeThreadBindingInput): Promise<BindHomeThreadResult>;
  resolveLastRoute(lookup: HomeThreadLookup, channel?: string): Promise<RememberedRoute | null>;
  rememberLastRoute(input: RememberHomeThreadRouteInput): Promise<HomeThreadRecord>;
}
