export interface SlashCommand {
  name: string;
  summary: string;
  expectsValue?: boolean;
}

export interface SlashCompletionContext {
  token: string;
  rangeStart: number;
  rangeEnd: number;
  matches: readonly SlashCommand[];
}

const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "/help", summary: "Show command and keybinding help" },
  { name: "/provider", summary: "Switch providers", expectsValue: true },
  { name: "/model", summary: "Change the active model", expectsValue: true },
  { name: "/thinking", summary: "Change the active thinking level", expectsValue: true },
  { name: "/compact", summary: "Summarize older context", expectsValue: true },
  { name: "/new", summary: "Start a fresh chat" },
  { name: "/resume", summary: "Resume a stored thread", expectsValue: true },
  { name: "/thread", summary: "Show the current thread id" },
  { name: "/threads", summary: "Open the recent-thread picker" },
  { name: "/abort", summary: "Abort the active run" },
  { name: "/exit", summary: "Leave the TUI" },
  { name: "/quit", summary: "Leave the TUI" },
] as const;

export function findSlashCommand(name: string): SlashCommand | undefined {
  return SLASH_COMMANDS.find((command) => command.name === name);
}

export function getSlashCompletionContext(
  value: string,
  cursor: number,
): SlashCompletionContext | null {
  const firstLineEnd = value.indexOf("\n");
  const firstLine = firstLineEnd === -1 ? value : value.slice(0, firstLineEnd);
  const leadingWhitespaceLength = firstLine.length - firstLine.trimStart().length;
  const trimmed = firstLine.slice(leadingWhitespaceLength);

  if (!trimmed.startsWith("/")) {
    return null;
  }

  const tokenMatch = trimmed.match(/^\/\S*/);
  const token = tokenMatch?.[0] ?? "/";
  const rangeStart = leadingWhitespaceLength;
  const rangeEnd = rangeStart + token.length;

  if (cursor < rangeStart || cursor > rangeEnd) {
    return null;
  }

  const query = token.slice(1).toLowerCase();
  const matches = SLASH_COMMANDS.filter((command) => command.name.slice(1).startsWith(query));

  return {
    token,
    rangeStart,
    rangeEnd,
    matches,
  };
}

export function applySlashCompletion(
  value: string,
  context: SlashCompletionContext,
  command: SlashCommand,
): { value: string; cursor: number } {
  const suffix = command.expectsValue ? " " : "";
  const replacement = command.name + suffix;
  const nextValue =
    value.slice(0, context.rangeStart) + replacement + value.slice(context.rangeEnd);

  return {
    value: nextValue,
    cursor: context.rangeStart + replacement.length,
  };
}
