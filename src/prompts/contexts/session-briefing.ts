export function renderSessionBriefingContext(options: {content: string}): string {
  return ` [session]\n${options.content} `.trim();
}
