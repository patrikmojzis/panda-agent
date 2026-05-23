import type {SessionTodoItem} from "../../domain/sessions/todos.js";
import {truncateText} from "../../lib/strings.js";

const DEFAULT_MAX_OPEN_ITEMS = 50;
const DEFAULT_MAX_DONE_ITEMS = 5;
const RENDERED_TODO_CONTENT_CHARS = 300;

export interface RenderSessionTodoContextOptions {
  items: readonly SessionTodoItem[];
  maxOpenItems?: number;
  maxDoneItems?: number;
}

function isOpenTodo(item: SessionTodoItem): boolean {
  return item.status !== "done";
}

function renderItem(item: SessionTodoItem): string {
  return `- [${item.status}] ${truncateText(item.content, RENDERED_TODO_CONTENT_CHARS)}`;
}

export function renderSessionTodoContext(options: RenderSessionTodoContextOptions): string {
  const maxOpenItems = options.maxOpenItems ?? DEFAULT_MAX_OPEN_ITEMS;
  const maxDoneItems = options.maxDoneItems ?? DEFAULT_MAX_DONE_ITEMS;
  const openItems = options.items.filter(isOpenTodo);
  const doneItems = options.items.filter((item) => item.status === "done");
  const visibleOpenItems = openItems.slice(0, maxOpenItems);
  const visibleDoneItems = doneItems.slice(Math.max(0, doneItems.length - maxDoneItems));
  const omittedOpenCount = Math.max(0, openItems.length - visibleOpenItems.length);
  const omittedDoneCount = Math.max(0, doneItems.length - visibleDoneItems.length);
  const lines = [
    "TODO:",
    ...visibleOpenItems.map(renderItem),
    ...(omittedOpenCount > 0 ? [`- ... ${omittedOpenCount} open todo item(s) omitted`] : []),
    ...visibleDoneItems.map(renderItem),
    ...(omittedDoneCount > 0 ? [`- ... ${omittedDoneCount} done todo item(s) omitted`] : []),
  ];

  return lines.length > 1 ? lines.join("\n") : "";
}
