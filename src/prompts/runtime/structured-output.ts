export function renderStructuredOutputInstruction(schema: string): string {
  return `
Return only valid JSON.
Do not wrap the JSON in Markdown fences.
The JSON must match this schema exactly:
\`\`\`json
${schema}
\`\`\`
`.trim();
}
