import type {ThreadToolJobStatus} from "../../domain/threads/runtime/types.js";
import type {
  BackgroundToolJobHandle,
  BackgroundToolJobSnapshot,
} from "../../domain/threads/runtime/tool-job-service.js";
import type {JsonObject} from "../../lib/json.js";

export interface PandaCommandExecution {
  ordinal: number;
  command: string;
  status: ThreadToolJobStatus;
  code?: string;
}

export interface BashCommandExecutionReadInput {
  threadId: string;
  runId: string;
  parentToolCallId: string;
}

/** Reads the sanitized Panda command executions observed under one bash tool call. */
export type BashCommandExecutionReader = (
  input: BashCommandExecutionReadInput,
) => Promise<readonly PandaCommandExecution[]>;

function commandToJson(command: PandaCommandExecution): JsonObject {
  return {
    ordinal: command.ordinal,
    command: command.command,
    status: command.status,
    ...(command.code ? {code: command.code} : {}),
  };
}

/** Builds the compact bash-level summary without pretending the surrounding shell is transactional. */
export function buildBashCommandExecutionSummary(input: {
  commands: readonly PandaCommandExecution[];
  shellSucceeded: boolean;
}): JsonObject | undefined {
  const commands = [...input.commands].sort((left, right) => left.ordinal - right.ordinal);
  const completed = commands.some((command) => command.status === "completed");
  const commandFailed = commands.some((command) => command.status !== "completed");
  const partialExecution = completed && (!input.shellSucceeded || commandFailed);

  if (commands.length === 0 || (commands.length === 1 && !partialExecution)) {
    return undefined;
  }

  return {
    partialExecution,
    pandaCommands: commands.map(commandToJson),
    remainingShellSteps: "unknown",
    ...(partialExecution
      ? {warning: "Earlier Panda commands completed and were not rolled back."}
      : {}),
  };
}

/** Adds the same terminal Panda-command summary to background done, status, and cancel snapshots. */
export function attachBashCommandExecutionSummary(
  handle: BackgroundToolJobHandle,
  readSummary: (shellSucceeded: boolean) => Promise<JsonObject | undefined>,
): BackgroundToolJobHandle {
  const decorateTerminal = async <T extends BackgroundToolJobSnapshot | void>(snapshot: T): Promise<T> => {
    if (!snapshot || snapshot.status === undefined || snapshot.status === "running") {
      return snapshot;
    }
    const commandSummary = await readSummary(snapshot.status === "completed");
    if (!commandSummary) {
      return snapshot;
    }

    return {
      ...snapshot,
      result: {
        ...(snapshot.result ?? {}),
        ...commandSummary,
      },
    } as T;
  };

  return {
    ...handle,
    done: handle.done.then(decorateTerminal),
    ...(handle.snapshot
      ? {snapshot: async () => decorateTerminal(await handle.snapshot?.())}
      : {}),
    ...(handle.cancel
      ? {cancel: async (reason?: string) => decorateTerminal(await handle.cancel?.(reason))}
      : {}),
  };
}
