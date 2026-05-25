import type {PgPoolLike} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import type {CreateThreadInput, ThreadRecord} from "../threads/runtime/types.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import {PostgresSessionStore} from "./postgres.js";
import type {CreateSessionInput, SessionRecord, UpdateSessionCurrentThreadInput, UpdateSessionRuntimeConfigInput} from "./types.js";

export interface CreateSessionWithThreadInput {
  pool: PgPoolLike;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  session: CreateSessionInput;
  thread: CreateThreadInput;
  runtimeConfig?: Omit<UpdateSessionRuntimeConfigInput, "sessionId">;
}

export interface ResetSessionThreadInput {
  pool: PgPoolLike;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  thread: CreateThreadInput;
  session: UpdateSessionCurrentThreadInput;
  runtimeConfig?: Omit<UpdateSessionRuntimeConfigInput, "sessionId">;
}

export async function createSessionWithInitialThread(
  input: CreateSessionWithThreadInput,
): Promise<{session: SessionRecord; thread: ThreadRecord}> {
  return withTransaction(input.pool, async (client) => {
    const session = await input.sessionStore.createSessionRecord(input.session, client);
    const thread = await input.threadStore.createThreadRecord(input.thread, client);
    if (input.runtimeConfig) {
      await input.sessionStore.updateSessionRuntimeConfigRecord({
        sessionId: session.id,
        ...input.runtimeConfig,
      }, client);
    }
    return {session, thread};
  });
}

export async function resetSessionCurrentThread(
  input: ResetSessionThreadInput,
): Promise<ThreadRecord> {
  return withTransaction(input.pool, async (client) => {
    const thread = await input.threadStore.createThreadRecord(input.thread, client);
    if (input.runtimeConfig) {
      await input.sessionStore.updateSessionRuntimeConfigRecord({
        sessionId: input.session.sessionId,
        ...input.runtimeConfig,
      }, client);
    }
    await input.sessionStore.updateCurrentThreadRecord(input.session, client);
    return thread;
  });
}
