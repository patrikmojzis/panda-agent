import {renderLlmContextDump} from "../../prompts/contexts/llm-context.js";

export interface LlmContextSnapshot {
  content: string;
  promptCacheKeyPart?: string | null;
}

export interface LlmContextRuntimeSection {
  name: string;
  content: string;
  dump: string;
}

export interface LlmContextRuntimeDump {
  dump: string;
  sections: readonly LlmContextRuntimeSection[];
  promptCacheKeyParts: readonly string[];
}

export abstract class LlmContext {
  name = this.constructor.name;

  abstract getContent(): Promise<string>;

  async getSnapshot(): Promise<LlmContextSnapshot> {
    return {content: await this.getContent()};
  }

  async dumps(): Promise<string> {
    const {content} = await this.getSnapshot();
    if (content.trim().length === 0) {
      return "";
    }

    return renderLlmContextDump(this.name, content);
  }
}

export async function gatherContexts(contexts: LlmContext[]): Promise<string> {
  const result = await gatherContextsForRuntime(contexts);
  return result.dump;
}

export async function gatherContextsForRuntime(contexts: LlmContext[]): Promise<LlmContextRuntimeDump> {
  const results = await Promise.all(contexts.map(async (context) => {
    const snapshot = await context.getSnapshot();
    const content = snapshot.content;
    const dump = content.trim().length > 0 ? renderLlmContextDump(context.name, content) : "";
    return {
      name: context.name,
      content,
      dump,
      promptCacheKeyPart: snapshot.promptCacheKeyPart?.trim() || undefined,
    };
  }));
  return {
    dump: results
      .map((result) => result.dump)
      .filter((result) => result.trim().length > 0)
      .join("\n\n"),
    sections: results
      .filter((result) => result.dump.trim().length > 0)
      .map((result) => ({
        name: result.name,
        content: result.content,
        dump: result.dump,
      })),
    promptCacheKeyParts: results
      .map((result) => result.promptCacheKeyPart)
      .filter((part): part is string => part !== undefined),
  };
}
