export abstract class LlmContext {
  name = this.constructor.name;

  abstract getContent(): Promise<string>;

  async dumps(): Promise<string> {
    return `**${this.name}:**\n\`\`\`${await this.getContent()}\`\`\``;
  }
}

export async function gatherContexts(contexts: LlmContext[]): Promise<string> {
  const results = await Promise.all(contexts.map((context) => context.dumps()));
  return results.join("\n\n");
}
