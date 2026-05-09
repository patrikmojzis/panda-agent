export interface WorkerRuntimeContextInput {
  role?: string;
  task?: string;
  context?: string;
  parentSessionId?: string;
  workspacePath?: string;
  inboxPath?: string;
  artifactsPath?: string;
  parentVisibleRoot?: string;
}

export function renderWorkerRuntimeContext(input: WorkerRuntimeContextInput): string {
  const lines = [
    `role: ${input.role ?? "worker"}`,
    ...(input.task ? [`task: ${input.task}`] : []),
    ...(input.context ? [`context: ${input.context}`] : []),
    ...(input.parentSessionId
      ? [
        `parentSessionId: ${input.parentSessionId}`,
        `message parent with: message_agent({ sessionId: ${JSON.stringify(input.parentSessionId)} })`,
      ]
      : []),
    `workspace: ${input.workspacePath ?? "/workspace"}`,
    `inbox: ${input.inboxPath ?? "/inbox"}`,
    `artifacts: ${input.artifactsPath ?? "/artifacts"}`,
    ...(input.parentVisibleRoot ? [`parent-visible root: ${input.parentVisibleRoot}`] : []),
    "Before starting substantive work, load every allowed skill with agent_skill(operation=\"load\") so you understand what is expected from you.",
  ];

  return lines.join("\n");
}
