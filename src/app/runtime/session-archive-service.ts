import {randomUUID} from "node:crypto";

import {PostgresSessionArchive, type SessionArchiveResult} from "../../domain/sessions/archive.js";
import type {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";

const ARCHIVE_ABORT_REASON = "Session archive requested.";
const SUBAGENT_ARCHIVE_BATCH_SIZE = 100;

/** Serializes archive and restore through the same scheduler lane as reset. */
export class SessionArchiveService {
  private readonly sessions: Pick<PostgresSessionStore, "getSession" | "listDirectSubagentThreads">;
  private readonly archiveStore: Pick<PostgresSessionArchive, "archive" | "restore">;
  private readonly coordinator: Pick<ThreadRuntimeCoordinator, "abort" | "runExclusively">;
  private readonly backgroundJobs: Pick<BackgroundToolJobService, "cancelThreadJobs">;

  constructor(options: {
    sessions: Pick<PostgresSessionStore, "getSession" | "listDirectSubagentThreads">;
    archiveStore: Pick<PostgresSessionArchive, "archive" | "restore">;
    coordinator: Pick<ThreadRuntimeCoordinator, "abort" | "runExclusively">;
    backgroundJobs: Pick<BackgroundToolJobService, "cancelThreadJobs">;
  }) {
    this.sessions = options.sessions;
    this.archiveStore = options.archiveStore;
    this.coordinator = options.coordinator;
    this.backgroundJobs = options.backgroundJobs;
  }

  async archive(sessionId: string, operationId: string): Promise<SessionArchiveResult & {stoppedSubagents: number}> {
    const session = await this.sessions.getSession(sessionId);
    if (session.kind !== "branch") {
      throw new Error(`Only branch sessions can be archived; session ${sessionId} is ${session.kind}.`);
    }
    await this.coordinator.abort(
      session.currentThreadId,
      ARCHIVE_ABORT_REASON,
      operationId,
      {blocksNewRuns: true},
    );
    const archived = await this.coordinator.runExclusively(session.currentThreadId, async ({signal, owner}) => {
      signal.throwIfAborted();
      await this.backgroundJobs.cancelThreadJobs(session.currentThreadId);
      return this.archiveStore.archive({
        sessionId,
        expectedThreadId: session.currentThreadId,
        owner,
      });
    });
    let afterSessionId: string | undefined;
    let stoppedSubagents = 0;
    while (true) {
      const children = await this.sessions.listDirectSubagentThreads({
        agentKey: session.agentKey,
        parentSessionId: session.id,
        ...(afterSessionId ? {afterSessionId} : {}),
        limit: SUBAGENT_ARCHIVE_BATCH_SIZE,
      });
      for (const child of children) {
        await this.coordinator.abort(
          child.currentThreadId,
          "Parent session archived.",
          randomUUID(),
          {blocksNewRuns: true},
        );
        await this.coordinator.runExclusively(child.currentThreadId, async ({signal}) => {
          signal.throwIfAborted();
          await this.backgroundJobs.cancelThreadJobs(child.currentThreadId);
        });
        stoppedSubagents += 1;
      }
      if (children.length < SUBAGENT_ARCHIVE_BATCH_SIZE) break;
      afterSessionId = children.at(-1)?.sessionId;
      if (!afterSessionId) break;
    }
    return {...archived, stoppedSubagents};
  }

  async restore(sessionId: string): Promise<SessionRecord> {
    const session = await this.sessions.getSession(sessionId);
    if (session.kind !== "branch") {
      throw new Error(`Only branch sessions can be restored; session ${sessionId} is ${session.kind}.`);
    }
    return this.coordinator.runExclusively(session.currentThreadId, async ({signal, owner}) => {
      signal.throwIfAborted();
      return this.archiveStore.restore({
        sessionId,
        expectedThreadId: session.currentThreadId,
        owner,
      });
    });
  }
}
