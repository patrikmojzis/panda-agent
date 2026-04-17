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
  { name: "/usage", summary: "Show current context, usage, and cost" },
  { name: "/model", summary: "Change the active model selector or reset to default", expectsValue: true },
  { name: "/thinking", summary: "Change the active thinking level", expectsValue: true },
  { name: "/compact", summary: "Summarize older context", expectsValue: true },
  { name: "/new", summary: "Start a fresh branch session" },
  { name: "/reset", summary: "Reset the current session onto a fresh thread" },
  { name: "/resume", summary: "Open a stored session", expectsValue: true },
  { name: "/thread", summary: "Show the current session and thread ids" },
  { name: "/sessions", summary: "Open the current agent's session picker" },
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
