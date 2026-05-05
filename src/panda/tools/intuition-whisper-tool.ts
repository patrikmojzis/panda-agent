import {z} from "zod";

import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {truncateText} from "../../lib/strings.js";

const MAX_WHISPER_CHARS = 4_000;

export interface IntuitionWhisper {
  parentThreadId: string;
  parentRunId: string;
  sidecarThreadId: string;
  sidecarRunId?: string;
  message: string;
}

export interface IntuitionWhisperSink {
  emitWhisper(input: IntuitionWhisper): Promise<void>;
}

export interface IntuitionWhisperToolOptions {
  sink: IntuitionWhisperSink;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readCurrentInputMetadata(context: unknown): Record<string, unknown> {
  if (!isRecord(context) || !isRecord(context.currentInput)) {
    return {};
  }

  return isRecord(context.currentInput.metadata) ? context.currentInput.metadata : {};
}

export class IntuitionWhisperTool<TContext = unknown>
  extends Tool<typeof IntuitionWhisperTool.schema, TContext> {
  static schema = z.object({
    message: z.string().trim().min(1).max(MAX_WHISPER_CHARS),
  });

  name = "whisper_to_main";
  description = "Send one private freeform intuition note to Panda's main thread. Use only when the note is materially useful; otherwise stay silent.";
  schema = IntuitionWhisperTool.schema;

  private readonly sink: IntuitionWhisperSink;

  constructor(options: IntuitionWhisperToolOptions) {
    super();
    this.sink = options.sink;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.message === "string"
      ? truncateText(args.message, 160)
      : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof IntuitionWhisperTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const context = run.context;
    const metadata = readCurrentInputMetadata(context);
    const parentThreadId = readString(metadata.parentThreadId);
    const parentRunId = readString(metadata.parentRunId);
    const sidecarThreadId = isRecord(context) ? readString(context.threadId) : undefined;
    const sidecarRunId = isRecord(context) ? readString(context.runId) : undefined;

    if (!parentThreadId || !parentRunId || !sidecarThreadId) {
      throw new ToolError("whisper_to_main requires a sidecar observation with parent run metadata.");
    }

    await this.sink.emitWhisper({
      parentThreadId,
      parentRunId,
      sidecarThreadId,
      sidecarRunId,
      message: args.message,
    });

    return {
      content: [{
        type: "text",
        text: "Whisper delivered to Panda's main thread.",
      }],
    };
  }
}
