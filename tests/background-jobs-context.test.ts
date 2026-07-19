import {describe, expect, it} from "vitest";

import type {ThreadToolJobRecord} from "../src/domain/threads/runtime/types.js";
import {BackgroundJobsContext} from "../src/panda/contexts/background-jobs-context.js";

describe("BackgroundJobsContext", () => {
  it("renders only running jobs without clock-derived elapsed time", async () => {
    const jobs: ThreadToolJobRecord[] = [
      {
        id: "job-running",
        threadId: "thread-1",
        kind: "bash",
        status: "running",
        summary: "sleep 10",
        startedAt: Date.parse("2026-07-19T10:00:00.000Z"),
      },
      {
        id: "job-completed",
        threadId: "thread-1",
        kind: "bash",
        status: "completed",
        summary: "printf done",
        startedAt: Date.parse("2026-07-19T09:00:00.000Z"),
      },
    ];
    const context = new BackgroundJobsContext({
      threadId: "thread-1",
      store: {
        listToolJobs: async () => jobs,
      },
    });

    const first = await context.getContent();
    const second = await context.getContent();

    expect(second).toBe(first);
    expect(first).toContain("job-running | bash | started 2026-07-19T10:00:00.000Z | sleep 10");
    expect(first).not.toContain("job-completed");
    expect(first).not.toContain("elapsed");
  });
});
