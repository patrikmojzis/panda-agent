import {randomUUID} from "node:crypto";

import {PostgresSubagentInventory} from "../../domain/subagents/inventory.js";
import {PostgresSessionArchive, type SessionArchiveResult} from "../../domain/sessions/archive.js";
import {PostgresSessionStore} from "../../domain/sessions/postgres.js";
import type {SessionRecord} from "../../domain/sessions/types.js";
import type {ThreadRuntimeCoordinator} from "../../domain/threads/runtime/coordinator.js";
import {PostgresThreadRuntimeStore} from "../../domain/threads/runtime/postgres.js";
import type {BackgroundToolJobService} from "../../domain/threads/runtime/tool-job-service.js";
import type {PgPoolLike} from "../../lib/postgres-query.js";

const ARCHIVE_ABORT_REASON = "Session archive requested.";

/** Serializes archive and restore through the same scheduler lane as reset. */
export class SessionArchiveService {
  private readonly sessions: PostgresSessionStore;
  private readonly archiveStore: PostgresSessionArchive;
  private readonly coordinator: Pick<ThreadRuntimeCoordinator, "abort" | "runExclusively">;
  private readonly backgroundJobs: Pick<BackgroundToolJobService, "cancelThreadJobs">;
  private readonly subagents: PostgresSubagentInventory;

  constructor(options: {
    pool: PgPoolLike;
    coordinator: Pick<ThreadRuntimeCoordinator, "abort" | "runExclusively">;
    backgroundJobs: Pick<BackgroundToolJobService, "cancelThreadJobs">;
  }) {
    this.sessions = new PostgresSessionStore({pool: options.pool});
    this.archiveStore = new PostgresSessionArchive({
      pool: options.pool,
      sessions: this.sessions,
      threads: new PostgresThreadRuntimeStore({pool: options.pool}),
    });
    this.coordinator = options.coordinator;
    this.backgroundJobs = options.backgroundJobs;
    this.subagents = new PostgresSubagentInventory(options.pool);
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
    const children = await this.subagents.list({
      agentKey: session.agentKey,
      parentSessionId: session.id,
      runStatus: "all",
      limit: 1_000,
    });
    for (const child of children.records) {
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
    }
    return {...archived, stoppedSubagents: children.records.length};
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
