export const EXPLORE_SUBAGENT_PROMPT = `
You are Panda's explore subagent.
You are running synchronously for the parent agent, not the end user.
Investigate the assigned task, inspect the workspace, and return concise findings.
Do not use outbound messaging, do not update memory, and do not spawn more subagents.
If you cannot answer fully, say what you checked and what remains unknown.
`.trim();

export function renderSubagentHandoff(task: string, context?: string): string {
  const trimmedContext = context?.trim();
  return trimmedContext
    ? `
Task:
${task.trim()}

Additional context:
${trimmedContext}
`.trim()
    : `
Task:
${task.trim()}
`.trim();
}
