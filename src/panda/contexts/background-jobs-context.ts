import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {collapseWhitespace, truncateText} from "../../lib/strings.js";
import {renderBackgroundJobsContext} from "../../prompts/contexts/background-jobs.js";

const COMMAND_PREVIEW_CHARS = 120;

export interface BackgroundJobsContextOptions {
  store: Pick<ThreadRuntimeStore, "listToolJobs">;
  threadId: string;
}

export class BackgroundJobsContext extends LlmContext {
  override name = "Background Jobs";

  private readonly store: Pick<ThreadRuntimeStore, "listToolJobs">;
  private readonly threadId: string;

  constructor(options: BackgroundJobsContextOptions) {
    super();
    this.store = options.store;
    this.threadId = options.threadId;
  }

  async getContent(): Promise<string> {
    const runningJobs = (await this.store.listToolJobs(this.threadId))
      .filter((job) => job.status === "running");

    return renderBackgroundJobsContext(runningJobs.map((job) => ({
      jobId: job.id,
      kind: job.kind,
      startedAt: new Date(job.startedAt).toISOString(),
      summary: truncateText(collapseWhitespace(job.summary), COMMAND_PREVIEW_CHARS),
    })));
  }
}
