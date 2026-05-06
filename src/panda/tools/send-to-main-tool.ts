import {z} from "zod";

import {Tool} from "../../kernel/agent/tool.js";
import {ToolError} from "../../kernel/agent/exceptions.js";
import type {RunContext} from "../../kernel/agent/run-context.js";
import type {ToolResultPayload} from "../../kernel/agent/types.js";
import {isRecord} from "../../lib/records.js";
import {truncateText} from "../../lib/strings.js";

const MAX_NOTE_CHARS = 4_000;

export interface SidecarNote {
  parentThreadId: string;
  parentRunId: string;
  sidecarKey: string;
  sidecarThreadId: string;
  sidecarRunId?: string;
  message: string;
}

export interface SidecarNoteSink {
  sendToMain(input: SidecarNote): Promise<void>;
}

export interface SendToMainToolOptions {
  sink: SidecarNoteSink;
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

export class SendToMainTool<TContext = unknown>
  extends Tool<typeof SendToMainTool.schema, TContext> {
  static schema = z.object({
    message: z.string().trim().min(1).max(MAX_NOTE_CHARS),
  });

  name = "send_to_main";
  description = "Send one private sidecar note to the main agent thread. Use only when it materially changes the next answer or action; otherwise stay silent.";
  schema = SendToMainTool.schema;

  private readonly sink: SidecarNoteSink;

  constructor(options: SendToMainToolOptions) {
    super();
    this.sink = options.sink;
  }

  override formatCall(args: Record<string, unknown>): string {
    return typeof args.message === "string"
      ? truncateText(args.message, 160)
      : super.formatCall(args);
  }

  async handle(
    args: z.output<typeof SendToMainTool.schema>,
    run: RunContext<TContext>,
  ): Promise<ToolResultPayload> {
    const context = run.context;
    const metadata = readCurrentInputMetadata(context);
    const parentThreadId = readString(metadata.parentThreadId);
    const parentRunId = readString(metadata.parentRunId);
    const sidecarKey = readString(metadata.sidecarKey);
    const sidecarThreadId = isRecord(context) ? readString(context.threadId) : undefined;
    const sidecarRunId = isRecord(context) ? readString(context.runId) : undefined;

    if (!parentThreadId || !parentRunId || !sidecarKey || !sidecarThreadId) {
      throw new ToolError("send_to_main requires a sidecar event with parent run metadata.");
    }

    await this.sink.sendToMain({
      parentThreadId,
      parentRunId,
      sidecarKey,
      sidecarThreadId,
      sidecarRunId,
      message: args.message,
    });

    return {
      content: [{
        type: "text",
        text: "Note delivered to the main thread.",
      }],
    };
  }
}
