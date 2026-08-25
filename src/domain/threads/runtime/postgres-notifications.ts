import {validateIdentifier} from "../../../lib/postgres-relations.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ThreadRuntimeNotification =
  | {
    kind: "thread_changed";
    threadId: string;
  }
  | {
    kind: "thread_runnable";
    threadId: string;
  }
  | {
    kind: "run_abort_requested";
    threadId: string;
    runId: string;
  };

/** Postgres LISTEN/NOTIFY channel for thread runtime store changes. */
export function buildThreadRuntimeNotificationChannel(): string {
  return validateIdentifier("runtime_events");
}

export function parseThreadRuntimeNotification(payload: string): ThreadRuntimeNotification | null {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (!parsed || typeof parsed.threadId !== "string" || !parsed.threadId.trim()) {
      return null;
    }

    if (parsed.kind === "thread_changed" || parsed.kind === "thread_runnable") {
      return {
        kind: parsed.kind,
        threadId: parsed.threadId,
      };
    }

    if (parsed.kind === "run_abort_requested" && typeof parsed.runId === "string" && UUID_PATTERN.test(parsed.runId)) {
      return {
        kind: parsed.kind,
        threadId: parsed.threadId,
        runId: parsed.runId,
      };
    }

    return null;
  } catch {
    return null;
  }
}
