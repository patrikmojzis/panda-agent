import {resolveCurrentSessionThread} from "../../domain/sessions/current-thread.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {
  compactThread,
  type CompactThreadOptions,
  type CompactThreadResult,
} from "../../kernel/transcript/compaction.js";
import {isCompactBoundaryRecord} from "../../kernel/transcript/checkpoint.js";
import {readMissingApiKeyMessageForModel} from "../../integrations/providers/shared/missing-api-key.js";
import {RetryableRuntimeRequestError} from "../../domain/threads/requests/errors.js";

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
    | "commitCompactionExclusively"
    | "getCompactionNoopOperation"
    | "getMessage"
    | "getThread"
    | "hasPendingWake"
    | "loadActiveTranscript"
    | "recordCompactionNoopOperation"
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

  async compactSession(
    sessionId: string,
    customInstructions = "",
    operationId?: string,
    externalSignal?: AbortSignal,
  ): Promise<SessionCompactionResult> {
    externalSignal?.throwIfAborted();
    const replay = await this.readCommittedOperation(operationId, {sessionId});
    if (replay) return replay;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const target = await resolveCurrentSessionThread(this.options.sessions, sessionId);
      const result = await this.compactResolvedThread(
        target.session.id,
        target.threadId,
        customInstructions,
        true,
        operationId,
        externalSignal,
      );
      if (result) {
        return result;
      }
    }

    throw new Error(`Session ${sessionId} kept changing threads while compaction was starting. Try again.`);
  }

  async compactThread(
    threadId: string,
    customInstructions = "",
    operationId?: string,
    externalSignal?: AbortSignal,
  ): Promise<SessionCompactionResult> {
    externalSignal?.throwIfAborted();
    const replay = await this.readCommittedOperation(operationId, {threadId});
    if (replay) return replay;
    const thread = await this.options.threads.getThread(threadId);
    const result = await this.compactResolvedThread(
      thread.sessionId,
      thread.id,
      customInstructions,
      false,
      operationId,
      externalSignal,
    );
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
    operationId?: string,
    externalSignal?: AbortSignal,
  ): Promise<SessionCompactionResult | null> {
    return this.options.coordinator.runExclusively(threadId, async (access) => {
      const signal = externalSignal
        ? AbortSignal.any([access.signal, externalSignal])
        : access.signal;
      signal.throwIfAborted();
      if (verifyCurrentThread) {
        const current = await resolveCurrentSessionThread(this.options.sessions, sessionId);
        if (current.threadId !== threadId) {
          return null;
        }
      }

      const thread = await this.options.threads.getThread(threadId);
      signal.throwIfAborted();
      const runConfig = await this.options.coordinator.resolveThreadRunConfig(thread);
      this.requireModelAccess(runConfig.model);

      if (await this.options.threads.hasPendingWake(threadId)) {
        throw new Error("Wait for queued input to run before compacting.");
      }
      signal.throwIfAborted();

      const compacted = await this.compact({
        store: {
          loadActiveTranscript: (targetThreadId) => {
            return this.options.threads.loadActiveTranscript(targetThreadId);
          },
          commitCompaction: async (targetThreadId, commit) => {
            try {
              return await this.options.threads.commitCompactionExclusively(
                targetThreadId,
                commit,
                access.owner,
              );
            } catch (error) {
              if (error instanceof RetryableRuntimeRequestError) throw error;
              throw new RetryableRuntimeRequestError(
                `Compaction operation ${operationId ?? "without an id"} commit outcome is ambiguous.`,
                {cause: error},
              );
            }
          },
        },
        thread,
        model: runConfig.model,
        thinking: runConfig.thinking,
        customInstructions,
        trigger: "manual",
        operationId,
        signal,
      });
      signal.throwIfAborted();
      if (!compacted && operationId) {
        try {
          await this.options.threads.recordCompactionNoopOperation(
            operationId,
            sessionId,
            threadId,
            access.owner,
          );
        } catch (error) {
          if (error instanceof RetryableRuntimeRequestError) throw error;
          throw new RetryableRuntimeRequestError(
            `Compaction no-op ${operationId} outcome is ambiguous.`,
            {cause: error},
          );
        }
      }

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

  private async readCommittedOperation(
    operationId: string | undefined,
    expected: {sessionId?: string; threadId?: string},
  ): Promise<SessionCompactionResult | null> {
    if (!operationId) return null;
    let record;
    try {
      record = await this.options.threads.getMessage(operationId);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Compaction operation ${operationId} could not read its boundary receipt.`,
        {cause: error},
      );
    }
    if (!record) {
      let noop;
      try {
        noop = await this.options.threads.getCompactionNoopOperation(operationId);
      } catch (error) {
        throw new RetryableRuntimeRequestError(
          `Compaction operation ${operationId} could not read its no-op receipt.`,
          {cause: error},
        );
      }
      if (!noop) return null;
      if (
        (expected.sessionId && noop.sessionId !== expected.sessionId)
        || (expected.threadId && noop.threadId !== expected.threadId)
      ) {
        throw new Error(`Compaction operation ${operationId} conflicts with another target.`);
      }
      return {
        compacted: false,
        sessionId: noop.sessionId,
        threadId: noop.threadId,
      };
    }
    if (!isCompactBoundaryRecord(record)) {
      throw new Error(`Compaction operation ${operationId} conflicts with another message.`);
    }
    let thread;
    try {
      thread = await this.options.threads.getThread(record.threadId);
    } catch (error) {
      throw new RetryableRuntimeRequestError(
        `Compaction operation ${operationId} could not read its target thread.`,
        {cause: error},
      );
    }
    if (
      (expected.sessionId && thread.sessionId !== expected.sessionId)
      || (expected.threadId && thread.id !== expected.threadId)
    ) {
      throw new Error(`Compaction operation ${operationId} conflicts with another target.`);
    }
    return {
      compacted: true,
      sessionId: thread.sessionId,
      threadId: thread.id,
      ...(typeof record.metadata.tokensBefore === "number" ? {tokensBefore: record.metadata.tokensBefore} : {}),
      ...(typeof record.metadata.tokensAfter === "number" ? {tokensAfter: record.metadata.tokensAfter} : {}),
    };
  }
}
