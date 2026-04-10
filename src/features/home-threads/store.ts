import type {BindHomeThreadResult, HomeThreadBindingInput, HomeThreadLookup, HomeThreadRecord,} from "./types.js";

export interface HomeThreadStore {
  resolveHomeThread(lookup: HomeThreadLookup): Promise<HomeThreadRecord | null>;
  bindHomeThread(input: HomeThreadBindingInput): Promise<BindHomeThreadResult>;
}
