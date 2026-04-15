import {findSlashCommand} from "./commands.js";
import {NEWLINE_HELP_LINES} from "./input.js";

interface ChatCommandHandlers {
  help(): Promise<boolean> | boolean;
  usage(): Promise<boolean> | boolean;
  model(value: string): Promise<boolean> | boolean;
  thinking(value: string): Promise<boolean> | boolean;
  compact(value: string): Promise<boolean> | boolean;
  newSession(): Promise<boolean> | boolean;
  resetSession(): Promise<boolean> | boolean;
  resume(value: string): Promise<boolean> | boolean;
  showThread(): Promise<boolean> | boolean;
  openSessionPicker(): Promise<boolean> | boolean;
  abort(): Promise<boolean> | boolean;
  exit(): Promise<boolean> | boolean;
  unknown(command: string): Promise<boolean> | boolean;
}

export function buildChatHelpText(thinkingCommandUsage: string): string {
  return [
    "Commands:",
    "/help shows command help.",
    "/usage shows current context estimates, provider token usage, and cost.",
    "/model <selector-or-alias> changes the active model.",
    `${thinkingCommandUsage} changes the active thinking level.`,
    "/compact [instructions] summarizes older context and keeps recent turns verbatim.",
    "/new starts a fresh branch session.",
    "/reset replaces the current session thread with a fresh empty thread.",
    "/resume <session-id> opens another stored session.",
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

function parseCommandLine(commandLine: string): { command: string; value: string } {
  const [command, ...rest] = commandLine.split(/\s+/);
  return {
    command: command ?? "",
    value: rest.join(" ").trim(),
  };
}

export async function runChatCommandLine(
  commandLine: string,
  handlers: ChatCommandHandlers,
): Promise<boolean> {
  const { command, value } = parseCommandLine(commandLine);

  switch (command) {
    case "/help":
      return await handlers.help();
    case "/usage":
      return await handlers.usage();
    case "/model":
      return await handlers.model(value);
    case "/thinking":
      return await handlers.thinking(value);
    case "/compact":
      return await handlers.compact(value);
    case "/new":
      return await handlers.newSession();
    case "/reset":
      return await handlers.resetSession();
    case "/resume":
      return await handlers.resume(value);
    case "/thread":
      return await handlers.showThread();
    case "/sessions":
      return await handlers.openSessionPicker();
    case "/abort":
      return await handlers.abort();
    case "/exit":
    case "/quit":
      return await handlers.exit();
    default:
      return await handlers.unknown(command || "");
  }
}

export function describeUnknownCommand(command: string): string {
  const maybeCommand = findSlashCommand(command);
  return maybeCommand
    ? `${command} needs more input.`
    : `Unknown command: ${command}`;
}
