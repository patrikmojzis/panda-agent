import {LlmContext, type LlmContextSnapshot} from "../../kernel/agent/llm-context.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {renderSessionTodoContext} from "../../prompts/contexts/session-todo.js";

export type SessionTodoContextStore = Pick<SessionStore, "readSessionTodo">;

export interface SessionTodoContextOptions {
  store: SessionTodoContextStore;
  sessionId: string;
}

export class SessionTodoContext extends LlmContext {
  override name = "Todo Context";
  private readonly options: SessionTodoContextOptions;

  constructor(options: SessionTodoContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const snapshot = await this.getSnapshot();
    return snapshot.content;
  }

  override async getSnapshot(): Promise<LlmContextSnapshot> {
    const todo = await this.options.store.readSessionTodo(this.options.sessionId);
    if (!todo || todo.items.length === 0) {
      return {content: ""};
    }

    return {
      content: renderSessionTodoContext({items: todo.items}),
      promptCacheKeyPart: `todo:${todo.itemsHash}:${todo.updatedAt}`,
    };
  }
}
