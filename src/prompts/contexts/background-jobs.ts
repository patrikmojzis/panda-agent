export interface RenderBackgroundJobsContextJob {
  jobId: string;
  mode: string;
  startedAt: string;
  elapsed: string;
  initialCwd: string;
  command: string;
}

export function renderBackgroundJobsContext(jobs: readonly RenderBackgroundJobsContextJob[]): string {
  if (jobs.length === 0) {
    return "";
  }

  return [
    "Background bash jobs currently running in this thread:",
    ...jobs.map((job) => {
      return `- ${job.jobId} | ${job.mode} | started ${job.startedAt} | elapsed ${job.elapsed} | cwd ${job.initialCwd} | ${job.command}`;
    }),
  ].join("\n");
}
