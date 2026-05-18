import type {SessionStore} from "./store.js";
import type {SessionRecord} from "./types.js";
import type {ThreadRuntimeCoordinator, ThreadWakeMode} from "../threads/runtime/coordinator.js";
import type {ThreadRuntimeStore} from "../threads/runtime/store.js";
import type {ThreadInputPayload} from "../threads/runtime/types.js";

export interface CurrentSessionThread {
  session: SessionRecord;
  threadId: string;
}

/**
 * Resolves the thread that should receive session-owned runtime work right now.
 */
export function requireCurrentSessionThread(session: SessionRecord): CurrentSessionThread {
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
    sessions: Pick<SessionStore, "getSession">;
    coordinator: Pick<ThreadRuntimeCoordinator, "submitInput">;
    mode?: ThreadWakeMode;
    payload: ThreadInputPayload;
  },
): Promise<CurrentSessionThread> {
  const target = await resolveCurrentSessionThread(input.sessions, input.sessionId);
  if (input.mode === undefined) {
    await input.coordinator.submitInput(target.threadId, input.payload);
    return target;
  }

  await input.coordinator.submitInput(target.threadId, input.payload, input.mode);
  return target;
}

/**
 * Queues input to the current thread for a durable session and returns the
 * resolved target. Use this for already-reserved work that should not run
 * through the live daemon coordinator directly.
 */
export async function enqueueCurrentSessionInput(
  input: {
    sessionId: string;
    sessions: Pick<SessionStore, "getSession">;
    threads: Pick<ThreadRuntimeStore, "enqueueInput">;
    mode?: ThreadWakeMode;
    payload: ThreadInputPayload;
  },
): Promise<CurrentSessionThread> {
  const target = await resolveCurrentSessionThread(input.sessions, input.sessionId);
  await input.threads.enqueueInput(target.threadId, input.payload, input.mode ?? "wake");
  return target;
}
