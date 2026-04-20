import type {ThreadRecord} from "./types.js";
import {isRecord} from "../../../lib/records.js";
import {trimToUndefined} from "../../../lib/strings.js";

/**
 * Reads `agentKey` from persisted thread runtime context when present.
 */
export function readThreadAgentKey(thread: ThreadRecord): string | undefined {
  if (!isRecord(thread.context)) {
    return undefined;
  }

  return trimToUndefined(thread.context.agentKey);
}
