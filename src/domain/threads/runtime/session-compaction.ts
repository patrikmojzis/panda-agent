import type {SessionCompactionOutcome, SessionCompactionStore} from "../../sessions/compaction.js";
import type {ThreadRuntimeStore} from "./store.js";
import type {ThreadRecord, ThreadRunRecord, ThreadTranscriptSnapshot} from "./types.js";
import {compactThread} from "../../../kernel/transcript/compaction.js";
import {isCompactBoundaryRecord} from "../../../kernel/transcript/checkpoint.js";
import type {ThinkingLevel} from "@earendil-works/pi-ai";
import {SESSION_COMPACTION_FAILED_REASON, SESSION_COMPACTION_SKIPPED_REASON} from "../../../prompts/runtime/compaction.js";
import {captureReplayContext, readRunInputContext} from "./input-context.js";

/** Runs inside the owning runner between steps, never through the exclusive scheduler lane. */
export async function processSessionCompaction(options: {
  requests: Pick<SessionCompactionStore, "read" | "complete">;
  threads: Pick<ThreadRuntimeStore, "getMessage" | "getThread" | "loadActiveTranscript" | "commitCompaction">;
  thread: ThreadRecord;
  run: ThreadRunRecord;
  transcript: ThreadTranscriptSnapshot;
  model: string;
  thinking?: ThinkingLevel;
  signal: AbortSignal;
}) {
  const request = await options.requests.read(options.thread.sessionId);
  if (!request) return null;
  options.signal.throwIfAborted();
  const receipt = await options.threads.getMessage(request.id);
  let outcome: SessionCompactionOutcome;
  if (receipt) {
    if (!isCompactBoundaryRecord(receipt)
      || (await options.threads.getThread(receipt.threadId)).sessionId !== request.sessionId
      || typeof receipt.metadata.tokensBefore !== "number" || typeof receipt.metadata.tokensAfter !== "number") {
      throw new Error("Compaction request conflicts with another operation.");
    }
    outcome = {status: "compacted", tokensBefore: receipt.metadata.tokensBefore, tokensAfter: receipt.metadata.tokensAfter};
  } else {
    const currentInput = readRunInputContext(options.transcript.records);
    const original = currentInput
      ? options.transcript.records.find((record) => record.id === currentInput.messageId)
        ?? await options.threads.getMessage(currentInput.messageId)
      : undefined;
    let committing = false;
    try {
      const result = await compactThread({
        store: {
          loadActiveTranscript: (threadId) => options.threads.loadActiveTranscript(threadId),
          commitCompaction: (threadId, commit) => {
            committing = true;
            return options.threads.commitCompaction(threadId, commit);
          },
        },
        thread: options.thread,
        transcript: options.transcript,
        model: options.model,
        thinking: options.thinking,
        customInstructions: request.instructions,
        trigger: "manual",
        operationId: request.id,
        owningRunId: options.run.id,
        allowPartialTurn: true,
        replayContext: captureReplayContext(options.transcript.records),
        preservedRequest: original?.message.role === "user" ? original.message : undefined,
        signal: options.signal,
      });
      outcome = result
        ? {status: "compacted", tokensBefore: result.tokensBefore, tokensAfter: result.tokensAfter}
        : {status: "skipped", reason: SESSION_COMPACTION_SKIPPED_REASON};
    } catch (error) {
      options.signal.throwIfAborted();
      // A failed commit response may hide a committed checkpoint. Keep the request
      // pending so recovery can replay its receipt instead of claiming failure.
      if (committing) throw error;
      outcome = {status: "failed", reason: SESSION_COMPACTION_FAILED_REASON};
    }
  }
  options.signal.throwIfAborted();
  return {message: await options.requests.complete(request, options.run.id, outcome)};
}
