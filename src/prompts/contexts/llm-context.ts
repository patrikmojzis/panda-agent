export function renderLlmContextDump(name: string, content: string): string {
  return `**${name}:**\n\`\`\`${content}\`\`\``;
}
