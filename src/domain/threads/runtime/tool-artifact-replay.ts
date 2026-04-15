import type {ThreadMessageRecord} from "./types.js";
import {rehydrateToolArtifactMessage} from "../../../kernel/agent/tool-artifacts.js";

export async function rehydrateProjectedToolArtifacts(
  transcript: readonly ThreadMessageRecord[],
): Promise<readonly ThreadMessageRecord[]> {
  let changed = false;

  const next: ThreadMessageRecord[] = [];
  for (const entry of transcript) {
    if (entry.message.role !== "toolResult") {
      next.push(entry);
      continue;
    }

    const message = await rehydrateToolArtifactMessage(entry.message);
    if (message === entry.message) {
      next.push(entry);
      continue;
    }

    changed = true;
    next.push({
      ...entry,
      message,
    });
  }

  return changed ? next : transcript;
}
