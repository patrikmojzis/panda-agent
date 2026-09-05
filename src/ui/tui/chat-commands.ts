import {findSlashCommand} from "./commands.js";
import {NEWLINE_HELP_LINES} from "./input.js";

export function buildChatHelpText(thinkingCommandUsage: string): string {
  return [
    "Commands:",
    "/help shows command help.",
    "/usage shows current context estimates, provider token usage, and cost.",
    "/model <selector-or-alias|default> changes the active model.",
    `${thinkingCommandUsage} changes the active thinking level.`,
    "/compact [instructions] summarizes older context and keeps recent turns verbatim.",
    "/new starts a fresh branch session.",
    "/reset replaces the current session thread with a fresh empty thread.",
    "/resume <session-id-or-alias> opens another stored session.",
    "/thread shows the current session and thread ids plus active settings.",
    "/sessions opens the session picker for the current agent.",
    "/abort aborts the active run.",
    "/exit leaves the TUI.",
    "",
    "Keys:",
    "Enter sends the current prompt.",
    ...NEWLINE_HELP_LINES,
    "Ctrl-C stops the active run and exits Panda.",
    "Tab cycles slash command suggestions and Enter completes them.",
    "Ctrl-R opens reverse history search.",
    "Ctrl-F opens transcript search.",
    "PgUp/PgDn or Alt-Up/Alt-Down scroll transcript history.",
    "Esc clears active search or returns to the transcript bottom.",
  ].join("\n");
}

export function describeUnknownCommand(command: string): string {
  const maybeCommand = findSlashCommand(command);
  return maybeCommand
    ? `${command} needs more input.`
    : `Unknown command: ${command}`;
}
