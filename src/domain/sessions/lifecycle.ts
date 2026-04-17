import type {PgPoolLike} from "../threads/runtime/postgres-db.js";
import {withTransaction} from "../threads/runtime/postgres-db.js";
import type {CreateThreadInput, ThreadRecord} from "../threads/runtime/types.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import {PostgresSessionStore} from "./postgres.js";
import type {CreateSessionInput, SessionRecord, UpdateSessionCurrentThreadInput} from "./types.js";

export interface CreateSessionWithThreadInput {
  pool: PgPoolLike;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  session: CreateSessionInput;
  thread: CreateThreadInput;
}

export interface ResetSessionThreadInput {
  pool: PgPoolLike;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  thread: CreateThreadInput;
  session: UpdateSessionCurrentThreadInput;
}

export async function createSessionWithInitialThread(
  input: CreateSessionWithThreadInput,
): Promise<{session: SessionRecord; thread: ThreadRecord}> {
  return withTransaction(input.pool, async (client) => {
    const session = await input.sessionStore.createSessionRecord(input.session, client);
    const thread = await input.threadStore.createThreadRecord(input.thread, client);
    return {session, thread};
  });
}

export async function resetSessionCurrentThread(
  input: ResetSessionThreadInput,
): Promise<ThreadRecord> {
  return withTransaction(input.pool, async (client) => {
    const thread = await input.threadStore.createThreadRecord(input.thread, client);
    await input.sessionStore.updateCurrentThreadRecord(input.session, client);
    return thread;
  });
}
