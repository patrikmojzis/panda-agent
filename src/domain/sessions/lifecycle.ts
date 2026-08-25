import type {PgPoolLike, PgQueryable} from "../../lib/postgres-query.js";
import {withTransaction} from "../../lib/postgres-transaction.js";
import {buildThreadRuntimeTableNames} from "../threads/runtime/postgres-shared.js";
import type {CreateThreadInput, ThreadRecord, ThreadRunOwner} from "../threads/runtime/types.js";
import {PostgresThreadRuntimeStore} from "../threads/runtime/postgres.js";
import {PostgresSessionStore} from "./postgres.js";
import {buildSessionTableNames} from "./postgres-shared.js";
import {buildConversationSessionTableNames} from "./conversations/postgres-shared.js";
import {buildSessionRouteTableNames} from "./routes/postgres-shared.js";
import type {BindConversationInput} from "./conversations/types.js";
import type {SessionRouteInput} from "./routes/types.js";
import {toJson} from "../../lib/postgres-values.js";
import type {CreateSessionInput, SessionRecord, UpdateSessionCurrentThreadInput, UpdateSessionRuntimeConfigInput} from "./types.js";
import {SessionArchivedError} from "../threads/runtime/store.js";

export class SessionCurrentThreadConflictError extends Error {
  override readonly name = "SessionCurrentThreadConflictError";
}

export interface CreateSessionWithThreadInput {
  pool: PgPoolLike;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  session: CreateSessionInput;
  thread: CreateThreadInput;
  runtimeConfig?: Omit<UpdateSessionRuntimeConfigInput, "sessionId">;
  operation?: {
    operationId: string;
    identityId: string;
    kind: "main" | "branch" | "subagent";
  };
  activeParentSessionId?: string;
}

export interface ResetSessionThreadInput {
  pool: PgPoolLike;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  thread: CreateThreadInput;
  session: UpdateSessionCurrentThreadInput;
  previousThreadId: string;
  owner: ThreadRunOwner;
  runtimeConfig?: Omit<UpdateSessionRuntimeConfigInput, "sessionId">;
  runtimeConfigOperationId?: string;
  channelRouting?: {
    conversation: BindConversationInput;
    route: SessionRouteInput;
  };
}

export interface RepairMissingSessionThreadInput {
  pool: PgPoolLike;
  sessionStore: PostgresSessionStore;
  threadStore: PostgresThreadRuntimeStore;
  thread: CreateThreadInput;
  session: UpdateSessionCurrentThreadInput;
  previousThreadId: string;
  runtimeConfig?: Omit<UpdateSessionRuntimeConfigInput, "sessionId">;
}

async function lockExpectedCurrentThread(
  queryable: PgQueryable,
  sessionId: string,
  expectedThreadId: string,
): Promise<void> {
  const sessionTables = buildSessionTableNames();
  const locked = await queryable.query(`
    SELECT current_thread_id
    FROM ${sessionTables.sessions}
    WHERE id = $1
    FOR UPDATE
  `, [sessionId]);
  const currentThreadId = (locked.rows[0] as {current_thread_id?: unknown} | undefined)?.current_thread_id;
  if (typeof currentThreadId !== "string") {
    throw new Error(`Unknown session ${sessionId}`);
  }
  if (currentThreadId !== expectedThreadId) {
    throw new SessionCurrentThreadConflictError(`Session ${sessionId} changed current thread before reset.`);
  }
}

export async function createSessionWithInitialThread(
  input: CreateSessionWithThreadInput,
): Promise<{session: SessionRecord; thread: ThreadRecord}> {
  return withTransaction(input.pool, async (client) => {
    if (input.activeParentSessionId) {
      const parent = await client.query(`
        SELECT id, archived_at
        FROM ${buildSessionTableNames().sessions}
        WHERE id = $1
          AND archived_at IS NULL
        FOR UPDATE
      `, [input.activeParentSessionId]);
      if (!parent.rows[0]) {
        const lifecycle = await client.query(`
          SELECT archived_at FROM ${buildSessionTableNames().sessions} WHERE id = $1
        `, [input.activeParentSessionId]);
        if (lifecycle.rows[0]) throw new SessionArchivedError(input.activeParentSessionId);
        throw new Error(`Unknown session ${input.activeParentSessionId}`);
      }
    }
    const session = await input.sessionStore.createSessionRecord(input.session, client);
    const thread = await input.threadStore.createThreadRecord(input.thread, client);
    if (input.runtimeConfig) {
      await input.sessionStore.updateSessionRuntimeConfigRecord({
        sessionId: session.id,
        ...input.runtimeConfig,
      }, client);
    }
    if (input.operation) {
      await input.sessionStore.recordSessionCreationOperationRecord({
        ...input.operation,
        agentKey: session.agentKey,
        sessionId: session.id,
        threadId: thread.id,
      }, client);
    }
    return {session, thread};
  });
}

export async function resetSessionCurrentThread(
  input: ResetSessionThreadInput,
): Promise<ThreadRecord> {
  if (
    input.thread.sessionId !== input.session.sessionId
    || input.thread.replacesThreadId !== input.previousThreadId
  ) {
    throw new Error("Reset replacement thread must preserve its session and predecessor lineage.");
  }
  return withTransaction(input.pool, async (client) => {
    // Claims fence owner -> session -> thread. Acquire the owner before the
    // session too: a queued lease renewal must never sit between those locks.
    await input.threadStore.lockOwnerRecord(input.owner, client);
    await lockExpectedCurrentThread(
      client,
      input.session.sessionId,
      input.previousThreadId,
    );
    await input.threadStore.assertExclusiveAccessAfterOwnerLockRecord(
      input.previousThreadId,
      input.owner,
      client,
    );
    await input.threadStore.discardPendingInputsRecord(input.previousThreadId, client);
    // A wake belongs to the current thread generation, not to the session for
    // eternity. Clear the old edge while holding the session lock; every wake
    // producer takes that same lock before it can re-arm the config row.
    const sessionTables = buildSessionTableNames();
    await client.query(`
      UPDATE ${sessionTables.sessionRuntimeConfig}
      SET pending_wake_at = NULL,
          updated_at = NOW()
      WHERE session_id = $1
        AND pending_wake_at IS NOT NULL
    `, [input.session.sessionId]);
    const thread = await input.threadStore.createThreadRecord(input.thread, client);
    if (input.runtimeConfig) {
      const update = {
        sessionId: input.session.sessionId,
        ...input.runtimeConfig,
      };
      if (input.runtimeConfigOperationId) {
        await input.sessionStore.updateSessionRuntimeConfigForOperationRecord(
          input.runtimeConfigOperationId,
          update,
          client,
        );
      } else {
        await input.sessionStore.updateSessionRuntimeConfigRecord(update, client);
      }
    }
    await input.sessionStore.updateCurrentThreadRecord(input.session, client);
    if (input.channelRouting) {
      const conversation = input.channelRouting.conversation;
      const conversationTable = buildConversationSessionTableNames().conversationSessions;
      await client.query(`
        INSERT INTO ${conversationTable} (
          source,
          connector_key,
          external_conversation_id,
          session_id,
          metadata
        ) VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (source, connector_key, external_conversation_id) DO UPDATE
        SET session_id = EXCLUDED.session_id,
            metadata = COALESCE(EXCLUDED.metadata, ${conversationTable}.metadata),
            updated_at = NOW()
      `, [
        conversation.source,
        conversation.connectorKey,
        conversation.externalConversationId,
        conversation.sessionId,
        toJson(conversation.metadata),
      ]);

      const route = input.channelRouting.route;
      const routeTable = buildSessionRouteTableNames().sessionRoutes;
      const identityPredicate = route.identityId ? "identity_id = $2" : "identity_id IS NULL";
      await client.query(`
        WITH updated AS (
          UPDATE ${routeTable}
          SET connector_key = $4,
              external_conversation_id = $5,
              external_actor_id = $6,
              external_message_id = $7,
              captured_at_ms = $8::bigint,
              metadata = $9::jsonb,
              updated_at = NOW()
          WHERE session_id = $1
            AND ${identityPredicate}
            AND channel = $3
            AND captured_at_ms <= $8::bigint
          RETURNING 1
        )
        INSERT INTO ${routeTable} (
          session_id,
          identity_id,
          channel,
          connector_key,
          external_conversation_id,
          external_actor_id,
          external_message_id,
          captured_at_ms,
          metadata
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::jsonb
        WHERE NOT EXISTS (SELECT 1 FROM updated)
          AND NOT EXISTS (
            SELECT 1 FROM ${routeTable}
            WHERE session_id = $1 AND ${identityPredicate} AND channel = $3
          )
        ON CONFLICT DO NOTHING
      `, [
        route.sessionId,
        route.identityId ?? null,
        route.route.source,
        route.route.connectorKey,
        route.route.externalConversationId,
        route.route.externalActorId ?? null,
        route.route.externalMessageId ?? null,
        route.route.capturedAt,
        toJson(route.route),
      ]);
    }
    return thread;
  });
}

/**
 * Repairs the narrow bootstrap case where a session references a thread row
 * that no longer exists. This is deliberately separate from reset: a live
 * thread may only be replaced through the daemon's exclusive scheduler lane.
 */
export async function repairMissingSessionCurrentThread(
  input: RepairMissingSessionThreadInput,
): Promise<ThreadRecord> {
  const sessionTables = buildSessionTableNames();
  const threadTables = buildThreadRuntimeTableNames();

  return withTransaction(input.pool, async (client) => {
    const lockedSession = await client.query(`
      SELECT current_thread_id
      FROM ${sessionTables.sessions}
      WHERE id = $1
      FOR UPDATE
    `, [input.session.sessionId]);
    const currentThreadId = (lockedSession.rows[0] as {current_thread_id?: unknown} | undefined)
      ?.current_thread_id;
    if (typeof currentThreadId !== "string") {
      throw new Error(`Unknown session ${input.session.sessionId}`);
    }
    if (currentThreadId !== input.previousThreadId) {
      throw new Error(
        `Session ${input.session.sessionId} changed current thread while its missing thread was being repaired.`,
      );
    }

    const existingThread = await client.query(`
      SELECT 1
      FROM ${threadTables.threads}
      WHERE id = $1
      LIMIT 1
    `, [input.previousThreadId]);
    if (existingThread.rows.length > 0) {
      throw new Error(
        `Thread ${input.previousThreadId} reappeared while session ${input.session.sessionId} was being repaired.`,
      );
    }

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
