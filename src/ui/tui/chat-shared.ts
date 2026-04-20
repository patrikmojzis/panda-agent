import {type ThinkingLevel} from "../../kernel/agent/index.js";
import type {TranscriptLine} from "./chat-view.js";
import type {SessionRecord} from "../../domain/sessions/index.js";

export type EntryRole = "assistant" | "user" | "tool" | "meta" | "error";
export type RunPhase = "idle" | "thinking";

export interface TranscriptEntry {
  id: number;
  role: EntryRole;
  title: string;
  body: string;
}

export interface TranscriptLineCacheEntry {
  role: EntryRole;
  title: string;
  body: string;
  bodyWidth: number;
  lines: readonly TranscriptLine[];
}

export interface SearchState {
  active: boolean;
  query: string;
  selected: number;
}

export interface SessionPickerState {
  active: boolean;
  loading: boolean;
  selected: number;
  sessions: readonly SessionRecord[];
  error: string | null;
}

export interface PendingLocalInput {
  id: string;
  threadId: string;
  text: string;
  createdAt: number;
}

export const LABEL_WIDTH = 16;
export const TRANSCRIPT_GUTTER_WIDTH = 2;
export const TICK_MS = 100;
export const SPINNER_FRAME_COUNT = 10;
export const STORED_SYNC_MS = 750;
export const MAX_VISIBLE_PENDING_LOCAL_INPUTS = 3;
export const NOTICE_MS = 3_600;
export const BRACKETED_PASTE_ON = "\u001b[?2004h";
export const BRACKETED_PASTE_OFF = "\u001b[?2004l";
export const THINKING_LEVELS: readonly ThinkingLevel[] = ["low", "medium", "high", "xhigh"];
export const WELCOME_ENTRY_TEXT = [
  "Type your request and press Enter to start a run with Panda.",
  "Start with a code change, a debugging question, or a quick explanation of this repo.",
].join("\n");

export interface ChatCliOptions {
  thinking?: ThinkingLevel;
  identity?: string;
  agent?: string;
  session?: string;
  dbUrl?: string;
}

export interface ChatCliResult {
  sessionId?: string;
  threadId?: string;
}

export function parseThinkingCommandValue(value: string): ThinkingLevel | "off" | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  if (normalized === "off" || normalized === "none") {
    return "off";
  }

  const matched = THINKING_LEVELS.find((level) => level === normalized);
  return matched ?? null;
}

export function formatThinkingLevel(value?: ThinkingLevel): string {
  return value ?? "off";
}

export function thinkingCommandUsage(): string {
  return `/thinking <${THINKING_LEVELS.join("|")}|off>`;
}

export function thinkingCommandValuesText(): string {
  return `${THINKING_LEVELS.join(", ")}, or off`;
}
