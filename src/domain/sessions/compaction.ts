import type {ThreadMessageRecord} from "../../kernel/transcript/types.js";

export interface SessionCompactionRequest {
  id: string;
  outcomeId: string;
  sessionId: string;
  instructions: string;
}

export type SessionCompactionOutcome =
  | {status: "compacted"; tokensBefore: number; tokensAfter: number}
  | {status: "skipped" | "failed"; reason: string};

/** Durable requests are owned by a session; only its current active run may settle them. */
export interface SessionCompactionStore {
  request(sessionId: string, runId: string, instructions: string): Promise<SessionCompactionRequest>;
  read(sessionId: string): Promise<SessionCompactionRequest | null>;
  complete(request: SessionCompactionRequest, runId: string, outcome: SessionCompactionOutcome): Promise<ThreadMessageRecord | null>;
}
