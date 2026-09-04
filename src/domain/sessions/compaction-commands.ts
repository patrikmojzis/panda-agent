import {isRecord} from "../../lib/records.js";
import type {CommandDescriptor, RegisteredCommand} from "../commands/types.js";
import type {SessionCompactionStore} from "./compaction.js";

export const sessionCompactCommandDescriptor: CommandDescriptor = {
  name: "session.compact",
  summary: "Compact your current session and continue working.",
  description: "Request compaction when accumulated context makes continued work inefficient, especially after substantial exploration or a completed phase. Optionally identify details to preserve. Compaction happens after the current tool batch, before your next model call; continue unfinished work afterward. A compaction request does not complete the task. Targets only the calling session.",
  usage: "panda session compact current [--instructions <text>]",
  inputModes: ["flags", "json"],
  outputModes: ["text", "json"],
  arguments: [
    {name: "instructions", description: "Optional guidance for what to preserve, up to 4096 characters.", valueType: "string"},
    {name: "json", description: "Structured input: {instructions?: string}.", valueType: "json"},
  ],
  examples: [
    {description: "Compact and continue the current task.", command: "panda session compact current"},
    {description: "Preserve specific working context.", command: 'panda session compact current --instructions "Preserve decisions, failing tests, and remaining work."'},
  ],
  requiredCapabilities: ["session.compact"],
  resultShape: {status: "requested", applyAt: "next_model_boundary"},
};

export function createSessionCompactCommand(store: Pick<SessionCompactionStore, "request">): RegisteredCommand {
  return {
    descriptor: sessionCompactCommandDescriptor,
    async execute(request) {
      if (!isRecord(request.input)) throw new Error("session.compact input must be an object.");
      for (const key of Object.keys(request.input)) {
        if (key !== "instructions") throw new Error(`session.compact does not accept ${key}.`);
      }
      const instructions = request.input.instructions === undefined ? "" : request.input.instructions;
      if (typeof instructions !== "string" || instructions.length > 4096 || instructions.includes("\0")) {
        throw new Error("session.compact instructions must be a string of at most 4096 characters without NUL bytes.");
      }
      if (!request.scope.runId) throw new Error("session.compact requires an active agent run.");
      request.signal?.throwIfAborted();
      await store.request(request.scope.sessionId, request.scope.runId, instructions.trim());
      return {
        ok: true,
        command: "session.compact",
        output: {status: "requested", applyAt: "next_model_boundary"},
        summary: "Compaction requested before the next model call. Continue your unfinished work afterward.",
      };
    },
  };
}
