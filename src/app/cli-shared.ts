import type {Command} from "commander";

export {DB_URL_OPTION_DESCRIPTION} from "../lib/cli.js";

/** Whether an action command or its non-root command group declares Postgres access. */
export function commandUsesDatabase(actionCommand: Command, rootCommand: Command): boolean {
  let current: Command | null = actionCommand;
  while (current) {
    // Root options configure the root action. Commander also exposes them to
    // every subcommand, but that must not turn DB-free servers into DB clients.
    if (current === rootCommand && actionCommand !== rootCommand) return false;
    if (current.options.some((option) => option.long === "--db-url")) return true;
    current = current.parent;
  }
  return false;
}
