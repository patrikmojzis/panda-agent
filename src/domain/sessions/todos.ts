import {createHash} from "node:crypto";

import {stableStringify, type JsonValue} from "../../lib/json.js";
import {collapseWhitespace} from "../../lib/strings.js";

export const SESSION_TODO_STATUSES = ["pending", "in_progress", "blocked", "done"] as const;
export type SessionTodoStatus = typeof SESSION_TODO_STATUSES[number];

export const MAX_SESSION_TODO_ITEMS = 100;
export const MAX_SESSION_TODO_CONTENT_CHARS = 500;

const SESSION_TODO_STATUS_SET = new Set<string>(SESSION_TODO_STATUSES);

export interface SessionTodoItem {
  status: SessionTodoStatus;
  content: string;
}

export interface SessionTodoRecord {
  sessionId: string;
  items: readonly SessionTodoItem[];
  itemsHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface ReplaceSessionTodoInput {
  sessionId: string;
  items: readonly SessionTodoItem[];
}

export function isSessionTodoStatus(value: unknown): value is SessionTodoStatus {
  return typeof value === "string" && SESSION_TODO_STATUS_SET.has(value);
}

function normalizeSessionTodoContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Session todo content must be a string.");
  }

  const content = collapseWhitespace(value);
  if (!content) {
    throw new Error("Session todo content must not be empty.");
  }

  if (content.length > MAX_SESSION_TODO_CONTENT_CHARS) {
    throw new Error(`Session todo content must be at most ${MAX_SESSION_TODO_CONTENT_CHARS} characters.`);
  }

  return content;
}

export function normalizeSessionTodoItems(value: readonly unknown[]): SessionTodoItem[] {
  if (!Array.isArray(value)) {
    throw new Error("Session todo items must be an array.");
  }

  if (value.length > MAX_SESSION_TODO_ITEMS) {
    throw new Error(`Session todo list must contain at most ${MAX_SESSION_TODO_ITEMS} items.`);
  }

  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`Session todo item ${index + 1} must be an object.`);
    }

    const record = item as Record<string, unknown>;
    if (!isSessionTodoStatus(record.status)) {
      throw new Error(`Session todo item ${index + 1} has unsupported status ${String(record.status)}.`);
    }

    return {
      status: record.status,
      content: normalizeSessionTodoContent(record.content),
    };
  });
}

export function calculateSessionTodoItemsHash(items: readonly SessionTodoItem[]): string {
  const jsonItems: JsonValue = items.map((item) => ({
    status: item.status,
    content: item.content,
  }));
  return createHash("sha256")
    .update(stableStringify(jsonItems))
    .digest("hex");
}
