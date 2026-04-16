import type {ThreadBashJobRecord, ThreadInputPayload} from "../../domain/threads/runtime/types.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {renderBackgroundBashEventPrompt} from "../../prompts/runtime/background-bash.js";

function buildBackgroundBashExternalMessageId(record: ThreadBashJobRecord): string {
  return `background_bash:${record.id}:${record.status}:${record.finishedAt ?? 0}`;
}

export function buildBackgroundBashThreadInput(record: ThreadBashJobRecord): ThreadInputPayload {
  return {
    message: stringToUserMessage(renderBackgroundBashEventPrompt({
      jobId: record.id,
      status: record.status,
      command: record.command,
      durationMs: record.durationMs,
      exitCode: record.exitCode,
      signal: record.signal ?? null,
      stdout: record.stdout,
      stderr: record.stderr,
    })),
    source: "background_bash",
    externalMessageId: buildBackgroundBashExternalMessageId(record),
    metadata: {
      kind: "background_bash_job_update",
      jobId: record.id,
      status: record.status,
      finishedAt: record.finishedAt ?? null,
    },
  };
}
