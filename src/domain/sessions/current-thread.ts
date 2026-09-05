import type {SessionStore} from "./store.js";
import type {SessionRecord} from "./types.js";
import type {ThreadRuntimeCoordinator, ThreadWakeMode} from "../threads/runtime/coordinator.js";
import {
  SessionArchivedError,
  type ThreadEnqueueResult,
} from "../threads/runtime/store.js";
import type {ThreadEnqueueOptions, ThreadInputPayload} from "../threads/runtime/types.js";

export interface CurrentSessionThread {
  session: SessionRecord;
  threadId: string;
}

export type SessionInputDeliveryResult = ThreadEnqueueResult & {threadId: string};

/**
 * Resolves the thread that should receive session-owned runtime work right now.
 */
export function requireCurrentSessionThread(session: SessionRecord): CurrentSessionThread {
  if (session.archivedAt !== undefined) {
    throw new SessionArchivedError(session.id);
  }
  const threadId = session.currentThreadId.trim();
  if (!threadId) {
    throw new Error(`Session ${session.id} has no current thread.`);
  }

  return {session, threadId};
}

export async function resolveCurrentSessionThread(
  sessions: Pick<SessionStore, "getSession">,
  sessionId: string,
): Promise<CurrentSessionThread> {
  return requireCurrentSessionThread(await sessions.getSession(sessionId));
}

/**
 * Submits input to the current thread for a durable session and returns the
 * resolved target. Use this when session-owned work should survive `/reset`.
 */
export async function submitCurrentSessionInput(
  input: {
    sessionId: string;
    coordinator: Pick<ThreadRuntimeCoordinator, "submitSessionInput">;
    mode?: ThreadWakeMode;
    payload: ThreadInputPayload;
    options?: ThreadEnqueueOptions;
  },
): Promise<SessionInputDeliveryResult> {
  const result = await input.coordinator.submitSessionInput(
    input.sessionId,
    input.payload,
    input.mode ?? "wake",
    input.options,
  );
  return {...result, threadId: result.input.threadId};
}
