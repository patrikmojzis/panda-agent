export interface RenderWorkersContextWorker {
  sessionId: string;
  environmentId?: string;
  role: string;
  state: string;
  startedAt: string;
  workspacePath?: string;
  inboxPath?: string;
  artifactsPath?: string;
}

export function renderWorkersContext(workers: readonly RenderWorkersContextWorker[]): string {
  if (workers.length === 0) {
    return "";
  }

  return [
    "Workers owned by this session:",
    ...workers.map((worker) => {
      const parts = [
        worker.sessionId,
        worker.environmentId ? `env ${worker.environmentId}` : "env unbound",
        `role ${worker.role}`,
        `state ${worker.state}`,
        `started ${worker.startedAt}`,
      ].filter(Boolean);
      const paths = [
        worker.workspacePath ? `workspace ${worker.workspacePath}` : "",
        worker.inboxPath ? `inbox ${worker.inboxPath}` : "",
        worker.artifactsPath ? `artifacts ${worker.artifactsPath}` : "",
      ].filter(Boolean);
      return `- ${parts.join(" | ")}${paths.length ? ` | ${paths.join(" | ")}` : ""}`;
    }),
  ].join("\n");
}
