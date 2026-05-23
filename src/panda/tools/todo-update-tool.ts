import {z} from "zod";

import type {RunContext} from "../../kernel/agent/run-context.js";
import {Tool} from "../../kernel/agent/tool.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {
  MAX_SESSION_TODO_ITEMS,
  MAX_SESSION_TODO_CONTENT_CHARS,
  SESSION_TODO_STATUSES,
  type SessionTodoItem,
} from "../../domain/sessions/todos.js";
import type {DefaultAgentSessionContext} from "../../app/runtime/panda-session-context.js";
import {readRequiredSessionToolScope, rethrowAsToolError} from "./shared.js";

const todoItemSchema = z.strictObject({
  status: z.enum(SESSION_TODO_STATUSES),
  content: z.string().trim().min(1).max(MAX_SESSION_TODO_CONTENT_CHARS),
});

const todoUpdateToolSchema = z.strictObject({
  items: z.array(todoItemSchema).max(MAX_SESSION_TODO_ITEMS).describe(
    "The full desired todo list for this session. Pass [] to clear all todos.",
  ),
});

export type TodoUpdateToolStore = Pick<SessionStore, "replaceSessionTodo">;

export interface TodoUpdateToolOptions {
  store: TodoUpdateToolStore;
}

export class TodoUpdateTool<TContext = DefaultAgentSessionContext>
  extends Tool<typeof todoUpdateToolSchema, TContext> {
  static schema = todoUpdateToolSchema;

  name = "todo_update";
  description = [
    "Replace the current session's durable todo context with the full ordered list provided.",
    "Scope comes from the runtime session; do not include a session id.",
    "Use items: [] to clear the todo context.",
  ].join(" ");
  schema = TodoUpdateTool.schema;

  constructor(private readonly options: TodoUpdateToolOptions) {
    super();
  }

  override formatCall(args: Record<string, unknown>): string {
    const items = Array.isArray(args.items) ? args.items : [];
    return items.length === 0 ? "clear" : `${items.length} item${items.length === 1 ? "" : "s"}`;
  }

  async handle(
    args: z.output<typeof todoUpdateToolSchema>,
    run: RunContext<TContext>,
  ): Promise<{
    updated: true;
    cleared: boolean;
    itemCount: number;
    openItemCount: number;
    doneItemCount: number;
  }> {
    try {
      const scope = readRequiredSessionToolScope(
        run.context,
        "todo_update requires sessionId in the runtime session context.",
      );
      const record = await this.options.store.replaceSessionTodo({
        sessionId: scope.sessionId,
        items: args.items as SessionTodoItem[],
      });
      const items = record?.items ?? [];
      const doneItemCount = items.filter((item) => item.status === "done").length;
      return {
        updated: true,
        cleared: items.length === 0,
        itemCount: items.length,
        openItemCount: items.length - doneItemCount,
        doneItemCount,
      };
    } catch (error) {
      rethrowAsToolError(error);
    }
  }
}
