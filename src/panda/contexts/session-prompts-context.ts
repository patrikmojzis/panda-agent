import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {SessionPromptRecord} from "../../domain/sessions/types.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {renderSessionPromptsContext} from "../../prompts/contexts/session-prompts.js";

export type SessionPromptsStore = Pick<SessionStore, "listSessionPrompts">;

export interface SessionPromptsContextOptions {
  store?: SessionPromptsStore;
  sessionId: string;
  prompts?: readonly SessionPromptRecord[] | null;
}

export class SessionPromptsContext extends LlmContext {
  override name = "Session Prompts";
  private readonly options: SessionPromptsContextOptions;

  constructor(options: SessionPromptsContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const prompts = this.options.prompts !== undefined
      ? this.options.prompts ?? []
      : await this.options.store?.listSessionPrompts(this.options.sessionId) ?? [];
    return renderSessionPromptsContext({prompts});
  }
}
