import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {ThreadRuntimeStore} from "../../domain/threads/runtime/store.js";
import {renderBackgroundJobsContext} from "../../prompts/contexts/background-jobs.js";

const COMMAND_PREVIEW_CHARS = 120;

function truncatePreview(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatElapsedDuration(startedAt: number, now: number): string {
  const elapsedMs = Math.max(0, now - startedAt);
  if (elapsedMs < 1_000) {
    return `${elapsedMs}ms`;
  }

  const elapsedSeconds = elapsedMs / 1_000;
  if (elapsedSeconds < 10) {
    return `${elapsedSeconds.toFixed(1)}s`;
  }

  if (elapsedSeconds < 60) {
    return `${Math.round(elapsedSeconds)}s`;
  }

  const elapsedMinutes = elapsedSeconds / 60;
  if (elapsedMinutes < 10) {
    return `${elapsedMinutes.toFixed(1)}m`;
  }

  return `${Math.round(elapsedMinutes)}m`;
}

export interface BackgroundJobsContextOptions {
  store: Pick<ThreadRuntimeStore, "listBashJobs">;
  threadId: string;
  now?: Date | (() => Date);
}

function resolveNow(now?: Date | (() => Date)): Date {
  if (typeof now === "function") {
    return now();
  }

  return now ?? new Date();
}

export class BackgroundJobsContext extends LlmContext {
  override name = "Background Bash Jobs";

  private readonly store: Pick<ThreadRuntimeStore, "listBashJobs">;
  private readonly threadId: string;
  private readonly now?: Date | (() => Date);

  constructor(options: BackgroundJobsContextOptions) {
    super();
    this.store = options.store;
    this.threadId = options.threadId;
    this.now = options.now;
  }

  async getContent(): Promise<string> {
    const now = resolveNow(this.now).getTime();
    const runningJobs = (await this.store.listBashJobs(this.threadId))
      .filter((job) => job.status === "running");

    return renderBackgroundJobsContext(runningJobs.map((job) => ({
      jobId: job.id,
      mode: job.mode,
      startedAt: new Date(job.startedAt).toISOString(),
      elapsed: formatElapsedDuration(job.startedAt, now),
      initialCwd: job.initialCwd,
      command: truncatePreview(job.command, COMMAND_PREVIEW_CHARS),
    })));
  }
}
