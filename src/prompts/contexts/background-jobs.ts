export interface RenderBackgroundJobsContextJob {
  jobId: string;
  kind: string;
  startedAt: string;
  summary: string;
}

export function renderBackgroundJobsContext(jobs: readonly RenderBackgroundJobsContextJob[]): string {
  if (jobs.length === 0) {
    return "";
  }

  return [
    "Background jobs currently running in this thread:",
    ...jobs.map((job) => {
      return `- ${job.jobId} | ${job.kind} | started ${job.startedAt} | ${job.summary}`;
    }),
  ].join("\n");
}
