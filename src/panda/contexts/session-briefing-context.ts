import {LlmContext} from "../../kernel/agent/llm-context.js";
import {SESSION_BRIEFING_PROMPT_SLUG, type SessionPromptRecord} from "../../domain/sessions/types.js";
import type {SessionStore} from "../../domain/sessions/store.js";
import {renderSessionBriefingContext} from "../../prompts/contexts/session-briefing.js";

export type SessionBriefingStore = Pick<SessionStore, "readSessionPrompt">;

export interface SessionBriefingContextOptions {
  store?: SessionBriefingStore;
  sessionId: string;
  prompt?: SessionPromptRecord | null;
}

export class SessionBriefingContext extends LlmContext {
  override name = "Session Briefing";
  private readonly options: SessionBriefingContextOptions;

  constructor(options: SessionBriefingContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const prompt = this.options.prompt !== undefined
      ? this.options.prompt
      : await this.options.store?.readSessionPrompt(this.options.sessionId, SESSION_BRIEFING_PROMPT_SLUG);
    const content = prompt?.content ?? "";
    return content.trim() ? renderSessionBriefingContext({content}) : "";
  }
}
