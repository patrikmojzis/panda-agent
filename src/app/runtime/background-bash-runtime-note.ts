import type {ThreadBashJobRecord, ThreadRuntimeMessagePayload} from "../../domain/threads/runtime/types.js";
import {renderBackgroundBashRuntimeNote} from "../../prompts/runtime/background-bash.js";

export function buildBackgroundBashRuntimeMessage(record: ThreadBashJobRecord): ThreadRuntimeMessagePayload {
  return {
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: renderBackgroundBashRuntimeNote({
          jobId: record.id,
          status: record.status,
          command: record.command,
          durationMs: record.durationMs,
          exitCode: record.exitCode,
          signal: record.signal ?? null,
          stdout: record.stdout,
          stderr: record.stderr,
        }),
      }],
      api: "openai-responses",
      provider: "openai",
      model: "system",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
    source: "background_bash",
    metadata: {
      kind: "background_bash_job_update",
      jobId: record.id,
      status: record.status,
    },
  };
}
