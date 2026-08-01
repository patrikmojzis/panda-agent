import {resolveCurrentSessionThread} from "../../domain/sessions/current-thread.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {
  compactThread,
  type CompactThreadOptions,
  type CompactThreadResult,
} from "../../kernel/transcript/compaction.js";
import {readMissingApiKeyMessageForModel} from "../../integrations/providers/shared/missing-api-key.js";

type CompactOperation = (options: CompactThreadOptions) => Promise<CompactThreadResult | null>;

export interface SessionCompactionResult {
  compacted: boolean;
  sessionId: string;
  threadId: string;
  tokensBefore?: number;
  tokensAfter?: number;
}

export interface SessionCompactionServiceOptions {
  sessions: Pick<SessionStore, "getSession">;
  threads: Pick<
    ThreadRuntimeStore,
    "appendRuntimeMessage" | "getThread" | "hasRunnableInputs" | "loadTranscript"
  >;
  coordinator: Pick<ThreadRuntimeCoordinator, "resolveThreadRunConfig" | "runExclusively">;
  compact?: CompactOperation;
  readMissingApiKeyMessage?: (model: string) => string | null | undefined;
}

/** Compacts the current thread behind a durable session without pinning a stale thread id. */
export class SessionCompactionService {
  private readonly compact: CompactOperation;
  private readonly readMissingApiKeyMessage: (model: string) => string | null | undefined;

  constructor(private readonly options: SessionCompactionServiceOptions) {
    this.compact = options.compact ?? compactThread;
    this.readMissingApiKeyMessage = options.readMissingApiKeyMessage ?? readMissingApiKeyMessageForModel;
  }

  async compactSession(sessionId: string, customInstructions = ""): Promise<SessionCompactionResult> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = await resolveCurrentSessionThread(this.options.sessions, sessionId);
      const result = await this.compactResolvedThread(target.session.id, target.threadId, customInstructions, true);
      if (result) {
        return result;
      }
    }

    throw new Error(`Session ${sessionId} kept changing threads while compaction was starting. Try again.`);
  }

  async compactThread(threadId: string, customInstructions = ""): Promise<SessionCompactionResult> {
    const thread = await this.options.threads.getThread(threadId);
    const result = await this.compactResolvedThread(thread.sessionId, thread.id, customInstructions, false);
    if (!result) {
      throw new Error(`Thread ${threadId} could not be compacted.`);
    }
    return result;
  }

  private async compactResolvedThread(
    sessionId: string,
    threadId: string,
    customInstructions: string,
    verifyCurrentThread: boolean,
  ): Promise<SessionCompactionResult | null> {
    return this.options.coordinator.runExclusively(threadId, async () => {
      if (verifyCurrentThread) {
        const current = await resolveCurrentSessionThread(this.options.sessions, sessionId);
        if (current.threadId !== threadId) {
          return null;
        }
      }

      const thread = await this.options.threads.getThread(threadId);
      const runConfig = await this.options.coordinator.resolveThreadRunConfig(thread);
      this.requireModelAccess(runConfig.model);

      if (await this.options.threads.hasRunnableInputs(threadId)) {
        throw new Error("Wait for queued input to run before compacting.");
      }

      const compacted = await this.compact({
        store: this.options.threads,
        thread,
        model: runConfig.model,
        thinking: runConfig.thinking,
        customInstructions,
        trigger: "manual",
      });

      return {
        compacted: Boolean(compacted),
        sessionId,
        threadId,
        ...(compacted
          ? {
            tokensBefore: compacted.tokensBefore,
            tokensAfter: compacted.tokensAfter,
          }
          : {}),
      };
    });
  }

  private requireModelAccess(model: string): void {
    const message = this.readMissingApiKeyMessage(model);
    if (message) {
      throw new Error(message);
    }
  }
}
