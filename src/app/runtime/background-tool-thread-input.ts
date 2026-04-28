import type {ThreadInputPayload, ThreadToolJobRecord} from "../../domain/threads/runtime/types.js";
import {stringToUserMessage} from "../../kernel/agent/helpers/input.js";
import {renderBackgroundToolJobEventPrompt} from "../../prompts/runtime/background-tool-job.js";

function buildBackgroundToolExternalMessageId(record: ThreadToolJobRecord): string {
  return `background_tool:${record.id}:${record.status}:${record.finishedAt ?? 0}`;
}

export function buildBackgroundToolThreadInput(record: ThreadToolJobRecord): ThreadInputPayload {
  const looseRecord = record as ThreadToolJobRecord & {
    command?: string;
  };
  const kind = looseRecord.kind ?? "bash";
  const summary = looseRecord.summary ?? looseRecord.command ?? kind;
  return {
    message: stringToUserMessage(renderBackgroundToolJobEventPrompt({
      jobId: record.id,
      kind,
      status: record.status,
      summary,
      durationMs: record.durationMs,
      result: record.result,
      error: record.error,
      reason: record.statusReason,
    })),
    source: "background_tool",
    externalMessageId: buildBackgroundToolExternalMessageId(record),
    metadata: {
      kind: "background_tool_job_update",
      jobId: record.id,
      jobKind: kind,
      status: record.status,
      finishedAt: record.finishedAt ?? null,
    },
  };
}
