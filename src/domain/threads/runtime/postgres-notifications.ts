import {validateIdentifier} from "../../../lib/postgres-relations.js";

export interface ThreadRuntimeNotification {
  threadId: string;
}

/** Postgres LISTEN/NOTIFY channel for thread runtime store changes. */
export function buildThreadRuntimeNotificationChannel(): string {
  return validateIdentifier("runtime_events");
}

export function parseThreadRuntimeNotification(payload: string): ThreadRuntimeNotification | null {
  try {
    const parsed = JSON.parse(payload) as Partial<ThreadRuntimeNotification>;
    if (!parsed || typeof parsed.threadId !== "string" || parsed.threadId.length === 0) {
      return null;
    }

    return {
      threadId: parsed.threadId,
    };
  } catch {
    return null;
  }
}
