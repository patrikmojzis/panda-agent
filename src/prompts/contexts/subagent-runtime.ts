export interface SubagentRuntimeContextInput {
  role?: string;
  task?: string;
  context?: string;
  parentSessionId?: string;
  execution?: "agent_workspace" | "isolated_environment";
  environmentId?: string;
}

export function renderSubagentRuntimeContext(input: SubagentRuntimeContextInput): string {
  const lines = [
    `role: ${input.role ?? "subagent"}`,
    ...(input.task ? [`task: ${input.task}`] : []),
    ...(input.context ? [`context: ${input.context}`] : []),
    ...(input.parentSessionId
      ? [
        `parentSessionId: ${input.parentSessionId}`,
        `message parent with: panda a2a send --to-session ${JSON.stringify(input.parentSessionId)} --text <message>`,
      ]
      : []),
    `spawn execution: ${input.execution ?? "agent_workspace"}`,
    ...(input.environmentId ? [`environmentId: ${input.environmentId}`] : []),
    "Before starting substantive work, load every allowed skill with panda skill load <skill-key> so you understand what is expected from you.",
  ];

  return lines.join("\n");
}
