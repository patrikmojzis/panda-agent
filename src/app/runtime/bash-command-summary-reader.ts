import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import type {
  BashCommandExecutionReader,
  PandaCommandExecution,
} from "../../panda/tools/bash-command-summary.js";

function readResultString(
  result: Record<string, unknown> | undefined,
  key: "code",
): string | undefined {
  const value = result?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Creates the narrow audit reader injected into BashTool. */
export function createBashCommandExecutionReader(
  store: Pick<ThreadRuntimeStore, "listCommandToolJobsByParent">,
): BashCommandExecutionReader {
  return async ({threadId, runId, parentToolCallId}) => {
    const jobs = await store.listCommandToolJobsByParent(threadId, runId, parentToolCallId);
    return jobs.map((job): PandaCommandExecution => {
      if (job.commandOrdinal === undefined) {
        throw new Error(`Command audit ${job.id} is missing its parent ordinal.`);
      }

      const result = job.result as Record<string, unknown> | undefined;
      const code = readResultString(result, "code");
      return {
        ordinal: job.commandOrdinal,
        command: job.summary,
        status: job.status,
        ...(code ? {code} : {}),
      };
    });
  };
}
