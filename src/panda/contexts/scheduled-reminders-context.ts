import {LlmContext} from "../../kernel/agent/llm-context.js";
import type {ScheduledTaskRecord, ScheduledTaskStore} from "../../domain/scheduling/tasks/index.js";
import {collapseWhitespace, stripInvisibleUnicode, truncateText} from "../../lib/strings.js";
import {renderScheduledRemindersContext} from "../../prompts/contexts/scheduled-reminders.js";

const DEFAULT_MAX_ITEMS = 12;
const INSTRUCTION_PREVIEW_CHARS = 160;

interface ScheduledRemindersContextOptions {
  store: Pick<ScheduledTaskStore, "listActiveTasks">;
  sessionId: string;
  now?: Date | (() => Date);
  maxItems?: number;
}

function resolveNow(now?: Date | (() => Date)): Date {
  return typeof now === "function" ? now() : now ?? new Date();
}

function sanitizeReminderField(value: string): string {
  return collapseWhitespace(stripInvisibleUnicode(value).replace(/[\u0000-\u001f\u007f]+/g, " "));
}

function formatSchedule(task: ScheduledTaskRecord): string {
  if (task.schedule.kind === "once") {
    return "once";
  }

  return `recurring ${sanitizeReminderField(task.schedule.cron)} ${sanitizeReminderField(task.schedule.timezone)}`;
}

function formatNextFireAt(task: ScheduledTaskRecord): string {
  if (task.nextFireAt === undefined) {
    return "unscheduled";
  }

  return new Date(task.nextFireAt).toISOString();
}

export class ScheduledRemindersContext extends LlmContext {
  override name = "Scheduled Reminders";

  private readonly options: ScheduledRemindersContextOptions;

  constructor(options: ScheduledRemindersContextOptions) {
    super();
    this.options = options;
  }

  async getContent(): Promise<string> {
    const limit = this.options.maxItems ?? DEFAULT_MAX_ITEMS;
    const now = resolveNow(this.options.now).getTime();

    try {
      const tasks = await this.options.store.listActiveTasks({
        sessionId: this.options.sessionId,
        limit: limit + 1,
      });
      const renderedTasks = tasks.slice(0, limit);

      return renderScheduledRemindersContext({
        items: renderedTasks.map((task) => ({
          taskId: task.id,
          title: sanitizeReminderField(task.title),
          nextFireAt: formatNextFireAt(task),
          schedule: formatSchedule(task),
          instructionPreview: truncateText(sanitizeReminderField(task.instruction), INSTRUCTION_PREVIEW_CHARS),
          overdue: task.nextFireAt !== undefined && task.nextFireAt <= now,
        })),
        truncated: tasks.length > limit,
      });
    } catch {
      // Reminder context is ambient. If storage is temporarily unavailable,
      // keep the main prompt clean and let scheduled task tools report errors.
      return "";
    }
  }
}
