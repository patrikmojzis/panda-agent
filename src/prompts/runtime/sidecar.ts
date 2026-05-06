import type {ThreadCheckpoint} from "../../kernel/agent/thread-checkpoint.js";
import type {ThreadRecord, ThreadRunRecord} from "../../domain/threads/runtime/types.js";
import type {SidecarDefinitionRecord, SidecarTrigger} from "../../domain/sidecars/types.js";

function renderCheckpointSummary(checkpoint: ThreadCheckpoint | undefined): readonly string[] {
  if (!checkpoint) {
    return [];
  }

  if (checkpoint.phase === "after_assistant") {
    return [
      `Checkpoint: ${checkpoint.phase}`,
      `Tool calls: ${checkpoint.toolCalls.map((call) => call.name).join(", ") || "none"}`,
    ];
  }

  return [
    `Checkpoint: ${checkpoint.phase}`,
    `Tool result: ${checkpoint.toolCall.name}`,
    `Tool errored: ${checkpoint.toolResult.isError === true ? "yes" : "no"}`,
    `Remaining tool calls: ${checkpoint.remainingToolCalls.map((call) => call.name).join(", ") || "none"}`,
  ];
}

export function renderSidecarEventPrompt(options: {
  trigger: SidecarTrigger;
  sidecar: SidecarDefinitionRecord;
  run: ThreadRunRecord;
  mainThread: ThreadRecord;
  checkpoint?: ThreadCheckpoint;
}): string {
  return [
    "[Sidecar event]",
    `Sidecar: ${options.sidecar.sidecarKey} (${options.sidecar.displayName})`,
    `Trigger: ${options.trigger}`,
    `Main run: ${options.run.id}`,
    `Main thread: ${options.mainThread.id}`,
    `Main session: ${options.mainThread.sessionId}`,
    ...renderCheckpointSummary(options.checkpoint),
    "",
    "Retrieve the run details from session.messages/session.tool_results/session.inputs using those IDs. Use your configured purpose. Call `send_to_main` only when your note should materially change the main agent's next answer or action; otherwise stay silent.",
  ].join("\n");
}
