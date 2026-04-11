import {renderLlmContextDump} from "../../prompts/contexts/llm-context.js";

export abstract class LlmContext {
  name = this.constructor.name;

  abstract getContent(): Promise<string>;

  async dumps(): Promise<string> {
    const content = await this.getContent();
    if (content.trim().length === 0) {
      return "";
    }

    return renderLlmContextDump(this.name, content);
  }
}

export async function gatherContexts(contexts: LlmContext[]): Promise<string> {
  const results = await Promise.all(contexts.map((context) => context.dumps()));
  return results
    .filter((result) => result.trim().length > 0)
    .join("\n\n");
}
