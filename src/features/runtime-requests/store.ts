import type {JsonValue} from "../agent-core/types.js";
import type {CreateRuntimeRequestInput, PandaRuntimeRequestPayload, PandaRuntimeRequestRecord,} from "./types.js";

export interface PandaRuntimeRequestStore {
  ensureSchema(): Promise<void>;
  enqueueRequest<TPayload extends PandaRuntimeRequestPayload>(
    input: CreateRuntimeRequestInput<TPayload>,
  ): Promise<PandaRuntimeRequestRecord<TPayload>>;
  claimNextPendingRequest(): Promise<PandaRuntimeRequestRecord | null>;
  completeRequest(id: string, result?: JsonValue): Promise<PandaRuntimeRequestRecord>;
  failRequest(id: string, error: string): Promise<PandaRuntimeRequestRecord>;
  getRequest(id: string): Promise<PandaRuntimeRequestRecord>;
  listenPendingRequests(listener: () => Promise<void> | void): Promise<() => Promise<void>>;
}
