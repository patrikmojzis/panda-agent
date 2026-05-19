export interface RenderWorkersContextWorker {
  sessionId: string;
  role: string;
  startedAt: string;
}

export interface RenderWorkersContextEnvironment {
  environmentId: string;
  state: string;
  startedAt: string;
  updatedAt: string;
  workspacePath?: string;
  inboxPath?: string;
  artifactsPath?: string;
  workers: readonly RenderWorkersContextWorker[];
  omittedWorkerCount?: number;
}

export function renderWorkersContext(environments: readonly RenderWorkersContextEnvironment[]): string {
  if (environments.length === 0) {
    return "";
  }

  return [
    "Worker environments owned by this session:",
    ...environments.map((environment) => {
      const parts = [
        environment.environmentId,
        `state ${environment.state}`,
        `started ${environment.startedAt}`,
        `updated ${environment.updatedAt}`,
      ].filter(Boolean);
      const paths = [
        environment.workspacePath ? `workspace ${environment.workspacePath}` : "",
        environment.inboxPath ? `inbox ${environment.inboxPath}` : "",
        environment.artifactsPath ? `artifacts ${environment.artifactsPath}` : "",
      ].filter(Boolean);
      const renderedWorkers = environment.workers.map((worker) => [
        worker.sessionId,
        `role ${worker.role}`,
        `started ${worker.startedAt}`,
      ].join(" ")).join("; ");
      const omittedWorkerCount = environment.omittedWorkerCount ?? 0;
      const omittedWorkers = omittedWorkerCount > 0
        ? `${renderedWorkers ? "; " : ""}${omittedWorkerCount} older ${omittedWorkerCount === 1 ? "worker" : "workers"} omitted`
        : "";
      const workers = renderedWorkers || omittedWorkers
        ? ` | workers ${renderedWorkers}${omittedWorkers}`
        : " | workers none";
      return `- ${parts.join(" | ")}${paths.length ? ` | ${paths.join(" | ")}` : ""}${workers}`;
    }),
  ].join("\n");
}
