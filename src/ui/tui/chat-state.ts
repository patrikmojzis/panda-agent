import {clamp} from "./screen.js";
import type {SearchState} from "./chat-shared.js";
import type {ViewModel} from "./chat-view.js";
import {applySlashCompletion, getSlashCompletionContext, type SlashCompletionContext} from "./commands.js";

export function findChatHistoryMatches(
  inputHistory: readonly string[],
  query: string,
): number[] {
  const normalizedQuery = query.trim().toLowerCase();
  const matches: number[] = [];

  for (let index = inputHistory.length - 1; index >= 0; index -= 1) {
    const value = inputHistory[index];
    if (!value) {
      continue;
    }

    if (!normalizedQuery || value.toLowerCase().includes(normalizedQuery)) {
      matches.push(index);
    }
  }

  return matches;
}

export function resolveCurrentChatHistoryMatch(
  inputHistory: readonly string[],
  search: SearchState,
): string | null {
  const matches = findChatHistoryMatches(inputHistory, search.query);
  if (matches.length === 0) {
    return null;
  }

  const selectedIndex = clamp(search.selected, 0, matches.length - 1);
  const historyIndex = matches[selectedIndex];
  if (historyIndex === undefined) {
    return null;
  }

  return inputHistory[historyIndex] ?? null;
}

export function resolveChatSlashContext(input: {
  value: string;
  cursor: number;
  lastSlashToken: string;
  slashCompletionIndex: number;
}): {
  context: SlashCompletionContext | null;
  lastSlashToken: string;
  slashCompletionIndex: number;
} {
  const context = getSlashCompletionContext(input.value, input.cursor);
  const token = context?.token ?? "";
  const nextToken = token !== input.lastSlashToken ? token : input.lastSlashToken;
  const nextIndex = token !== input.lastSlashToken
    ? 0
    : !context || context.matches.length === 0
    ? 0
    : clamp(input.slashCompletionIndex, 0, context.matches.length - 1);

  return {
    context,
    lastSlashToken: nextToken,
    slashCompletionIndex: nextIndex,
  };
}

export function applySelectedChatSlashCompletion(input: {
  composerValue: string;
  composerCursor: number;
  context: SlashCompletionContext | null;
  slashCompletionIndex: number;
}): {applied: false} | {applied: true; value: string; cursor: number} {
  if (!input.context || input.context.matches.length === 0) {
    return {applied: false};
  }

  const command = input.context.matches[input.slashCompletionIndex];
  if (!command) {
    return {applied: false};
  }

  const remainder = input.composerValue.slice(input.context.rangeEnd);
  const alreadyComplete = input.context.token === command.name;
  const alreadyHasValue = command.expectsValue && /^\s+\S/.test(remainder);
  if (alreadyComplete && (!command.expectsValue || alreadyHasValue || remainder.startsWith(" "))) {
    return {applied: false};
  }

  const next = applySlashCompletion(input.composerValue, input.context, command);
  return {
    applied: true,
    value: next.value,
    cursor: next.cursor,
  };
}

export function resolveSelectedTranscriptMatchScroll(view: ViewModel): number | null {
  if (view.selectedTranscriptLine === null) {
    return null;
  }

  if (view.selectedTranscriptLine < view.resolvedScrollTop) {
    return view.selectedTranscriptLine;
  }

  if (view.selectedTranscriptLine >= view.resolvedScrollTop + view.transcriptHeight) {
    return view.selectedTranscriptLine - view.transcriptHeight + 1;
  }

  return view.resolvedScrollTop;
}

export function resolveScrolledTranscript(input: {
  view: ViewModel;
  delta: number;
}): {followTranscript: boolean; scrollTop: number} {
  const scrollTop = clamp(input.view.resolvedScrollTop + input.delta, 0, input.view.maxScrollTop);
  return {
    followTranscript: scrollTop >= input.view.maxScrollTop,
    scrollTop,
  };
}

export function resolveTranscriptBottom(view: ViewModel): {followTranscript: true; scrollTop: number} {
  return {
    followTranscript: true,
    scrollTop: view.maxScrollTop,
  };
}

export function startChatHistorySearch(inputHistory: readonly string[]): {started: true} | {
  started: false;
  notice: string;
} {
  if (inputHistory.length === 0) {
    return {
      started: false,
      notice: "No previous prompts yet.",
    };
  }

  return {started: true};
}

export function cycleChatHistorySelection(
  search: SearchState,
  inputHistory: readonly string[],
  delta: number,
): number {
  const matches = findChatHistoryMatches(inputHistory, search.query);
  if (matches.length === 0) {
    return search.selected;
  }

  return clamp(search.selected + delta, 0, matches.length - 1);
}

export function cycleChatTranscriptSelection(
  search: SearchState,
  view: ViewModel,
  delta: number,
): number {
  if (view.transcriptMatches.length === 0) {
    return search.selected;
  }

  return clamp(search.selected + delta, 0, view.transcriptMatches.length - 1);
}

export function recordChatHistory(inputHistory: string[], value: string): void {
  if (!value.trim()) {
    return;
  }

  if (inputHistory.at(-1) === value) {
    return;
  }

  inputHistory.push(value);
}
