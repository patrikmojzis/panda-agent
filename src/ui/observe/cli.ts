import {Command, InvalidArgumentError} from "commander";

import {DB_URL_OPTION_DESCRIPTION} from "../../app/cli-shared.js";
import {parseAgentKey} from "../../domain/agents/cli.js";
import {parsePositiveIntegerOption, parseRequiredOptionValue, parseSessionIdOption,} from "../../lib/cli.js";
import {type ObserveRunOptions, runObserveApp,} from "./app.js";

interface ObserveCliOptions {
  agent?: string;
  session?: string;
  thread?: string;
  dbUrl?: string;
  once?: boolean;
  tail?: number;
}

function parseThreadIdOption(value: string): string {
  return parseRequiredOptionValue(value, "Thread id");
}

function resolveObserveTarget(options: ObserveCliOptions): ObserveRunOptions["target"] {
  const targets: ObserveRunOptions["target"][] = [];
  if (options.agent) {
    targets.push({kind: "agent", agentKey: options.agent});
  }
  if (options.session) {
    targets.push({kind: "session", sessionId: options.session});
  }
  if (options.thread) {
    targets.push({kind: "thread", threadId: options.thread});
  }

  if (targets.length === 0) {
    throw new InvalidArgumentError("Pass exactly one of --agent, --session, or --thread.");
  }

  if (targets.length > 1) {
    throw new InvalidArgumentError("Pick one target: --agent, --session, or --thread.");
  }

  return targets[0]!;
}

export async function runObserveCliCommand(options: ObserveCliOptions): Promise<void> {
  await runObserveApp({
    target: resolveObserveTarget(options),
    dbUrl: options.dbUrl,
    once: options.once,
    tail: options.tail,
  });
}

export function registerObserveCommand(program: Command): void {
  program
    .command("observe")
    .description("Follow stored Panda activity without opening chat")
    .option("--agent <agentKey>", "Observe an agent's main session", parseAgentKey)
    .option("--session <sessionId>", "Observe a session and follow resets", parseSessionIdOption)
    .option("--thread <threadId>", "Observe one concrete thread", parseThreadIdOption)
    .option("--db-url <url>", DB_URL_OPTION_DESCRIPTION)
    .option("--once", "Print the current snapshot once and exit")
    .option("--tail <messages>", "Stored messages to print on the initial snapshot", parsePositiveIntegerOption)
    .action((options: ObserveCliOptions) => {
      return runObserveCliCommand(options);
    });
}
