import type {JsonObject} from "../../lib/json.js";
import {isJsonObject} from "../../lib/json.js";
import {isRecord} from "../../lib/records.js";
import type {CommandDescriptor, CommandRequest, CommandSuccess, RegisteredCommand} from "../commands/types.js";
import type {SessionStore} from "./store.js";
import {normalizeSessionTodoItems, type SessionTodoItem, type SessionTodoStatus} from "./todos.js";

export const TODO_ADD_COMMAND_NAME = "todo.add";
export const TODO_DONE_COMMAND_NAME = "todo.done";
export const TODO_BLOCK_COMMAND_NAME = "todo.block";
export const TODO_CLEAR_COMMAND_NAME = "todo.clear";
export const TODO_LIST_COMMAND_NAME = "todo.list";
export const TODO_SHOW_COMMAND_NAME = "todo.show";

export type TodoReadCommandStore = Pick<SessionStore, "readSessionTodo">;
export type TodoItemMutationCommandStore = Pick<SessionStore, "readSessionTodo" | "replaceSessionTodo">;
export type TodoClearCommandStore = Pick<SessionStore, "replaceSessionTodo">;

interface TodoAddCommandInput {
  content: string;
  status?: Exclude<SessionTodoStatus, "done">;
}

interface TodoStatusMutationCommandInput {
  index: number;
}

interface TodoListCommandInput {
  status?: SessionTodoStatus | "open" | "all";
}

interface TodoShowCommandInput {
  index: number;
}

function requireCommandJsonObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  return value;
}

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }

  return value;
}

function readPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return value;
}

function readOptionalOpenTodoStatus(value: unknown): Exclude<SessionTodoStatus, "done"> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value === "pending" || value === "in_progress" || value === "blocked") {
    return value;
  }

  throw new Error("todo.add status must be pending, in_progress, or blocked.");
}

function parseTodoAddInput(input: unknown): TodoAddCommandInput {
  if (!isRecord(input)) {
    throw new Error("todo.add input must be a JSON object.");
  }

  return {
    content: readRequiredString(input.content, "todo.add content"),
    status: readOptionalOpenTodoStatus(input.status),
  };
}

function parseTodoStatusMutationInput(input: unknown, commandName: typeof TODO_DONE_COMMAND_NAME | typeof TODO_BLOCK_COMMAND_NAME): TodoStatusMutationCommandInput {
  if (!isRecord(input)) {
    throw new Error(`${commandName} input must be a JSON object.`);
  }

  return {
    index: readPositiveInteger(input.index, `${commandName} index`),
  };
}

function parseTodoListInput(input: unknown): TodoListCommandInput {
  if (!isRecord(input)) {
    throw new Error("todo.list input must be a JSON object.");
  }

  const status = input.status;
  if (status === undefined || status === null) {
    return {};
  }
  if (
    status === "all"
    || status === "open"
    || status === "pending"
    || status === "in_progress"
    || status === "blocked"
    || status === "done"
  ) {
    return {status};
  }

  throw new Error("todo.list status must be all, open, pending, in_progress, blocked, or done.");
}

function parseTodoShowInput(input: unknown): TodoShowCommandInput {
  if (!isRecord(input)) {
    throw new Error("todo.show input must be a JSON object.");
  }

  return {
    index: readPositiveInteger(input.index, "todo.show index"),
  };
}

function parseTodoClearInput(input: unknown): void {
  if (!isRecord(input)) {
    throw new Error("todo.clear input must be a JSON object.");
  }

  const unsupportedField = Object.keys(input)[0];
  if (unsupportedField) {
    throw new Error(`todo.clear has unsupported field ${unsupportedField}.`);
  }
}

function buildTodoMutationOutput(items: readonly SessionTodoItem[], label: string, extra?: JsonObject): JsonObject {
  const doneItemCount = items.filter((item) => item.status === "done").length;
  return requireCommandJsonObject({
    updated: true,
    cleared: items.length === 0,
    itemCount: items.length,
    openItemCount: items.length - doneItemCount,
    doneItemCount,
    ...(extra ?? {}),
  }, label);
}

function serializeTodoItem(item: SessionTodoItem, index?: number): JsonObject {
  return {
    ...(index === undefined ? {} : {index}),
    status: item.status,
    content: item.content,
  };
}

function buildTodoListOutput(items: readonly SessionTodoItem[], input: TodoListCommandInput): JsonObject {
  const status = input.status ?? "open";
  const filteredItems = items.flatMap((item, index) => {
    const itemIndex = index + 1;
    if (status === "all") {
      return [serializeTodoItem(item, itemIndex)];
    }
    if (status === "open") {
      return item.status === "done" ? [] : [serializeTodoItem(item, itemIndex)];
    }

    return item.status === status ? [serializeTodoItem(item, itemIndex)] : [];
  });
  const doneItemCount = items.filter((item) => item.status === "done").length;

  return requireCommandJsonObject({
    operation: "list",
    status,
    count: filteredItems.length,
    itemCount: items.length,
    openItemCount: items.length - doneItemCount,
    doneItemCount,
    items: filteredItems,
  }, "todo.list result");
}

function normalizeOneTodoItem(item: SessionTodoItem): SessionTodoItem {
  const [normalized] = normalizeSessionTodoItems([item]);
  if (!normalized) {
    throw new Error("Failed to normalize todo item.");
  }

  return normalized;
}

async function readTodoItems(store: Pick<SessionStore, "readSessionTodo">, sessionId: string): Promise<readonly SessionTodoItem[]> {
  const record = await store.readSessionTodo(sessionId);
  return record?.items ?? [];
}

function updateTodoStatus(items: readonly SessionTodoItem[], index: number, status: SessionTodoStatus): {
  item: SessionTodoItem;
  items: SessionTodoItem[];
} {
  if (index > items.length) {
    throw new Error(`Todo item ${index} does not exist.`);
  }

  const zeroBasedIndex = index - 1;
  const nextItems = items.map((item, currentIndex) => currentIndex === zeroBasedIndex
    ? normalizeOneTodoItem({...item, status})
    : item);
  const item = nextItems[zeroBasedIndex];
  if (!item) {
    throw new Error(`Todo item ${index} does not exist.`);
  }

  return {
    item,
    items: nextItems,
  };
}

export const todoAddCommandDescriptor: CommandDescriptor = {
  name: TODO_ADD_COMMAND_NAME,
  summary: "Add an item to the current session todo list.",
  description: "Appends one item to the current session's durable todo context without replacing the whole list.",
  usage: "panda todo add <text|@file|@-> [--status pending|in_progress|blocked]",
  inputModes: ["flags", "json", "stdin", "file"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "content",
      description: "Todo item content. Accepts literal text, @file, or @-.",
      required: true,
      kind: "positional",
      valueType: "string",
      valueName: "text|@file|@-",
      valueSources: ["literal", "file", "stdin"] as const,
    },
    {
      name: "status",
      description: "Initial status. Defaults to pending.",
      valueType: "string",
      valueName: "pending|in_progress|blocked",
    },
    {
      name: "json",
      description: "Structured JSON object containing content and optional status.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Add a pending item",
      command: "panda todo add \"Inspect code\"",
    },
    {
      description: "Add an in-progress item from stdin",
      command: "cat task.txt | panda todo add @- --status in_progress",
    },
  ],
  requiredCapabilities: [TODO_ADD_COMMAND_NAME],
  resultShape: {
    updated: true,
    itemIndex: "number",
    item: "object",
    itemCount: "number",
  },
};

export const todoDoneCommandDescriptor: CommandDescriptor = {
  name: TODO_DONE_COMMAND_NAME,
  summary: "Mark a todo item done.",
  description: "Marks one item in the current session todo list as done using its 1-based list index.",
  usage: "panda todo done <index>",
  inputModes: ["flags", "json"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "index",
      description: "1-based todo item index.",
      required: true,
      kind: "positional",
      valueType: "number",
      valueName: "index",
    },
    {
      name: "json",
      description: "Structured JSON object containing index.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Mark item 1 done",
      command: "panda todo done 1",
    },
  ],
  requiredCapabilities: [TODO_DONE_COMMAND_NAME],
  resultShape: {
    updated: true,
    itemIndex: "number",
    item: "object",
    doneItemCount: "number",
  },
};

export const todoBlockCommandDescriptor: CommandDescriptor = {
  name: TODO_BLOCK_COMMAND_NAME,
  summary: "Mark a todo item blocked.",
  description: "Marks one item in the current session todo list as blocked using its 1-based list index.",
  usage: "panda todo block <index>",
  inputModes: ["flags", "json"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "index",
      description: "1-based todo item index.",
      required: true,
      kind: "positional",
      valueType: "number",
      valueName: "index",
    },
    {
      name: "json",
      description: "Structured JSON object containing index.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Mark item 2 blocked",
      command: "panda todo block 2",
    },
  ],
  requiredCapabilities: [TODO_BLOCK_COMMAND_NAME],
  resultShape: {
    updated: true,
    itemIndex: "number",
    item: "object",
    openItemCount: "number",
  },
};

export const todoClearCommandDescriptor: CommandDescriptor = {
  name: TODO_CLEAR_COMMAND_NAME,
  summary: "Clear the current session todo list.",
  description: "Clears the current session's durable todo context without requiring a JSON replacement payload.",
  usage: "panda todo clear",
  inputModes: ["flags", "json"],
  outputModes: ["json", "text"],
  arguments: [],
  examples: [
    {
      description: "Clear todo list",
      command: "panda todo clear",
    },
    {
      description: "Clear through JSON transport",
      command: "panda todo clear --json '{}'",
    },
  ],
  requiredCapabilities: [TODO_CLEAR_COMMAND_NAME],
  resultShape: {
    updated: true,
    cleared: true,
    itemCount: 0,
    openItemCount: 0,
    doneItemCount: 0,
  },
};

export const todoListCommandDescriptor: CommandDescriptor = {
  name: TODO_LIST_COMMAND_NAME,
  summary: "List todo items for the current session.",
  description: "Reads the current session's durable todo context. Defaults to open items so done work does not bury active work.",
  usage: "panda todo list [--status all|open|pending|in_progress|blocked|done]",
  inputModes: ["flags", "json"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "status",
      description: "Filter items by status. Defaults to open.",
      valueType: "string",
      valueName: "all|open|pending|in_progress|blocked|done",
      defaultValue: "open",
    },
    {
      name: "json",
      description: "Structured JSON object containing optional status.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "List open items",
      command: "panda todo list",
    },
    {
      description: "List every item including done",
      command: "panda todo list --status all",
    },
  ],
  requiredCapabilities: [TODO_LIST_COMMAND_NAME],
  resultShape: {
    operation: "list",
    status: "all|open|pending|in_progress|blocked|done",
    count: "number",
    itemCount: "number",
    openItemCount: "number",
    doneItemCount: "number",
    items: [{
      index: "number",
      status: "pending|in_progress|blocked|done",
      content: "string",
    }],
  },
};

export const todoShowCommandDescriptor: CommandDescriptor = {
  name: TODO_SHOW_COMMAND_NAME,
  summary: "Show one todo item for the current session.",
  description: "Reads one item from the current session's durable todo context by its 1-based list index.",
  usage: "panda todo show <index>",
  inputModes: ["flags", "json"],
  outputModes: ["json", "text"],
  arguments: [
    {
      name: "index",
      description: "1-based todo item index.",
      required: true,
      kind: "positional",
      valueType: "number",
      valueName: "index",
    },
    {
      name: "json",
      description: "Structured JSON object containing index.",
      valueType: "json",
    },
  ],
  examples: [
    {
      description: "Show item 1",
      command: "panda todo show 1",
    },
  ],
  requiredCapabilities: [TODO_SHOW_COMMAND_NAME],
  resultShape: {
    operation: "show",
    itemIndex: "number",
    item: {
      index: "number",
      status: "pending|in_progress|blocked|done",
      content: "string",
    },
    itemCount: "number",
  },
};

export function createTodoListCommand(store: TodoReadCommandStore): RegisteredCommand {
  return {
    descriptor: todoListCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseTodoListInput(request.input);
      const items = await readTodoItems(store, request.scope.sessionId);
      const output = buildTodoListOutput(items, input);
      const count = Array.isArray(output.items) ? output.items.length : 0;

      return {
        ok: true,
        command: TODO_LIST_COMMAND_NAME,
        output,
        summary: `Listed ${count} todo item${count === 1 ? "" : "s"}.`,
      };
    },
  };
}

export function createTodoShowCommand(store: TodoReadCommandStore): RegisteredCommand {
  return {
    descriptor: todoShowCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseTodoShowInput(request.input);
      const items = await readTodoItems(store, request.scope.sessionId);
      const item = items[input.index - 1];
      if (!item) {
        throw new Error(`Todo item ${input.index} does not exist.`);
      }

      return {
        ok: true,
        command: TODO_SHOW_COMMAND_NAME,
        output: requireCommandJsonObject({
          operation: "show",
          itemIndex: input.index,
          item: serializeTodoItem(item, input.index),
          itemCount: items.length,
        }, "todo.show result"),
        summary: `Showed todo item ${input.index}.`,
      };
    },
  };
}

export function createTodoAddCommand(store: TodoItemMutationCommandStore): RegisteredCommand {
  return {
    descriptor: todoAddCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseTodoAddInput(request.input);
      const currentItems = await readTodoItems(store, request.scope.sessionId);
      const item = normalizeOneTodoItem({
        status: input.status ?? "pending",
        content: input.content,
      });
      const record = await store.replaceSessionTodo({
        sessionId: request.scope.sessionId,
        items: normalizeSessionTodoItems([...currentItems, item]),
      });
      const items = record?.items ?? [];
      const output = buildTodoMutationOutput(items, "todo.add result", {
        itemIndex: items.length,
        item: serializeTodoItem(item),
      });

      return {
        ok: true,
        command: TODO_ADD_COMMAND_NAME,
        output,
        summary: `Added todo item ${items.length}.`,
      };
    },
  };
}

function createTodoStatusMutationCommand(
  descriptor: CommandDescriptor,
  commandName: typeof TODO_DONE_COMMAND_NAME | typeof TODO_BLOCK_COMMAND_NAME,
  status: SessionTodoStatus,
  store: TodoItemMutationCommandStore,
): RegisteredCommand {
  return {
    descriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      const input = parseTodoStatusMutationInput(request.input, commandName);
      const currentItems = await readTodoItems(store, request.scope.sessionId);
      const mutation = updateTodoStatus(currentItems, input.index, status);
      const record = await store.replaceSessionTodo({
        sessionId: request.scope.sessionId,
        items: mutation.items,
      });
      const items = record?.items ?? [];
      const output = buildTodoMutationOutput(items, `${commandName} result`, {
        itemIndex: input.index,
        item: serializeTodoItem(mutation.item),
      });

      return {
        ok: true,
        command: commandName,
        output,
        summary: `Marked todo item ${input.index} ${status}.`,
      };
    },
  };
}

export function createTodoDoneCommand(store: TodoItemMutationCommandStore): RegisteredCommand {
  return createTodoStatusMutationCommand(todoDoneCommandDescriptor, TODO_DONE_COMMAND_NAME, "done", store);
}

export function createTodoBlockCommand(store: TodoItemMutationCommandStore): RegisteredCommand {
  return createTodoStatusMutationCommand(todoBlockCommandDescriptor, TODO_BLOCK_COMMAND_NAME, "blocked", store);
}

export function createTodoClearCommand(store: TodoClearCommandStore): RegisteredCommand {
  return {
    descriptor: todoClearCommandDescriptor,
    async execute(request: CommandRequest): Promise<CommandSuccess<JsonObject>> {
      parseTodoClearInput(request.input);
      const record = await store.replaceSessionTodo({
        sessionId: request.scope.sessionId,
        items: [],
      });
      const items = record?.items ?? [];
      const output = buildTodoMutationOutput(items, "todo.clear result");

      return {
        ok: true,
        command: TODO_CLEAR_COMMAND_NAME,
        output,
        summary: "Cleared session todos.",
      };
    },
  };
}
