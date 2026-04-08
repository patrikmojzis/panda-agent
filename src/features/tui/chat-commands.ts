import { findSlashCommand } from "./commands.js";

interface ChatCommandHandlers {
  help(): Promise<boolean> | boolean;
  provider(value: string): Promise<boolean> | boolean;
  model(value: string): Promise<boolean> | boolean;
  thinking(value: string): Promise<boolean> | boolean;
  compact(value: string): Promise<boolean> | boolean;
  newThread(): Promise<boolean> | boolean;
  resume(value: string): Promise<boolean> | boolean;
  showThread(): Promise<boolean> | boolean;
  openThreadPicker(): Promise<boolean> | boolean;
  abort(): Promise<boolean> | boolean;
  exit(): Promise<boolean> | boolean;
  unknown(command: string): Promise<boolean> | boolean;
}

export function buildChatHelpText(thinkingCommandUsage: string): string {
  return [
    "Commands:",
    "/help shows command help.",
    "/provider <openai|openai-codex|anthropic|anthropic-oauth> switches providers for this stored thread.",
    "/model <name> changes the active model.",
    `${thinkingCommandUsage} changes the active thinking level.`,
    "/compact [instructions] summarizes older context and keeps recent turns verbatim.",
    "/new starts a fresh stored thread.",
    "/resume <thread-id> switches to another stored thread.",
    "/thread shows the current thread id and storage mode.",
    "/threads opens the recent-thread picker.",
    "/abort aborts the active run.",
    "/exit leaves the TUI.",
    "",
    "Keys:",
    "Enter sends the current prompt.",
    "\\ + Enter inserts a newline.",
    "Shift-Enter or Meta-Enter also inserts a newline when your terminal exposes it.",
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
    case "/provider":
      return await handlers.provider(value);
    case "/model":
      return await handlers.model(value);
    case "/thinking":
      return await handlers.thinking(value);
    case "/compact":
      return await handlers.compact(value);
    case "/new":
      return await handlers.newThread();
    case "/resume":
      return await handlers.resume(value);
    case "/thread":
      return await handlers.showThread();
    case "/threads":
      return await handlers.openThreadPicker();
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
