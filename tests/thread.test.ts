import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@mariozechner/pi-ai";

import {
  Agent,
  Hook,
  RunPipeline,
  Thread,
  Tool,
  stringToUserMessage,
  z,
  type LlmRuntime,
  type RunContext,
  type ThreadRunEvent,
  type ToolResultPayload,
} from "../src/index.js";

class EchoTool extends Tool<typeof EchoTool.schema> {
  name = "echo";
  description = "Echo a message";
  static schema = z.object({
    message: z.string(),
  });
  schema = EchoTool.schema;

  async handle(
    args: z.output<typeof EchoTool.schema>,
    run: RunContext,
  ): Promise<{ echoed: string; turn: number }> {
    return {
      echoed: args.message,
      turn: run.turn,
    };
  }
}

class ProgressTool extends Tool<typeof ProgressTool.schema> {
  name = "progress";
  description = "Emit tool progress";
  static schema = z.object({
    message: z.string(),
  });
  schema = ProgressTool.schema;

  async handle(
    args: z.output<typeof ProgressTool.schema>,
    run: RunContext,
  ): Promise<{ done: string }> {
    run.emitToolProgress({
      phase: "started",
      message: args.message,
    });

    run.emitToolProgress({
      phase: "finished",
      message: args.message,
    });

    return {
      done: args.message,
    };
  }
}

class RichOutputTool extends Tool<typeof RichOutputTool.schema> {
  name = "rich-output";
  description = "Return text and image content";
  static schema = z.object({
    caption: z.string(),
  });
  schema = RichOutputTool.schema;

  async handle(
    args: z.output<typeof RichOutputTool.schema>,
    _run: RunContext,
  ): Promise<ToolResultPayload> {
    return {
      content: [
        { type: "text", text: args.caption },
        { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
      ],
      details: {
        kind: "preview",
      },
    };
  }
}

class RecordingHook extends Hook {
  constructor(private readonly events: string[]) {
    super();
  }

  override async onStart(): Promise<void> {
    this.events.push("start");
  }

  override async onEnd(): Promise<void> {
    this.events.push("end");
  }
}

class RecordingPipeline extends RunPipeline {
  constructor(private readonly events: string[]) {
    super();
  }

  override async preflight(): Promise<void> {
    this.events.push("preflight");
  }

  override async postflight(): Promise<void> {
    this.events.push("postflight");
  }
}

function createAssistantMessage(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";

  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.1",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}

function createMockRuntime(...responses: AssistantMessage[]): LlmRuntime {
  return {
    complete: vi.fn().mockImplementation(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("No more mock responses queued");
      }

      return response as AssistantMessage;
    }),
    stream: vi.fn(() => {
      throw new Error("Streaming was not expected in this test");
    }),
  };
}

function message(text: string): AssistantMessage {
  return createAssistantMessage([{ type: "text", text }]);
}

function eventKind(event: ThreadRunEvent): string {
  return "type" in event ? event.type : event.role;
}

describe("Thread", () => {
  it("runs recursive tool calls and hook/pipeline callbacks", async () => {
    const events: string[] = [];
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "echo",
          arguments: { message: "hi" },
        },
      ]),
      message("done"),
    );

    const thread = new Thread({
      agent: new Agent({
        name: "core",
        instructions: "Use tools when needed",
        model: "gpt-4o-mini",
        tools: [new EchoTool()],
      }),
      messages: [stringToUserMessage("call the tool")],
      runtime,
      hooks: [new RecordingHook(events)],
      runPipelines: [new RecordingPipeline(events)],
    });

    const outputs: ThreadRunEvent[] = [];
    for await (const output of thread.run()) {
      outputs.push(output);
    }

    expect(outputs.map(eventKind)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(outputs[1]).toMatchObject({
      role: "toolResult",
      toolName: "echo",
      details: {
        echoed: "hi",
        turn: 1,
      },
    });
    expect(events).toEqual([
      "preflight",
      "start",
      "end",
      "postflight",
      "preflight",
      "start",
      "end",
      "postflight",
    ]);
  });

  it("parses structured output with zod", async () => {
    const runtime = createMockRuntime(message(JSON.stringify({ answer: "42" })));

    const thread = new Thread({
      agent: new Agent({
        name: "structured",
        instructions: "Return JSON",
        model: "gpt-4o-mini",
        outputSchema: z.object({
          answer: z.string(),
        }),
      }),
      messages: [stringToUserMessage("What is the answer?")],
      runtime,
    });

    await expect(thread.runToCompletion()).resolves.toEqual({ answer: "42" });
  });

  it("streams tool progress events before the final tool result", async () => {
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "progress",
          arguments: { message: "working" },
        },
      ]),
      message("done"),
    );

    const thread = new Thread({
      agent: new Agent({
        name: "progress-agent",
        instructions: "Use the progress tool",
        model: "gpt-4o-mini",
        tools: [new ProgressTool()],
      }),
      messages: [stringToUserMessage("show progress")],
      runtime,
    });

    const outputs: ThreadRunEvent[] = [];
    for await (const output of thread.run()) {
      outputs.push(output);
    }

    expect(outputs.map(eventKind)).toEqual([
      "assistant",
      "tool_progress",
      "tool_progress",
      "toolResult",
      "assistant",
    ]);
    expect(outputs[1]).toMatchObject({
      type: "tool_progress",
      toolName: "progress",
    });
  });

  it("preserves rich tool result content for follow-up model turns", async () => {
    const runtime = createMockRuntime(
      createAssistantMessage([
        {
          type: "toolCall",
          id: "call_1",
          name: "rich-output",
          arguments: { caption: "Image attached" },
        },
      ]),
      message("done"),
    );

    const thread = new Thread({
      agent: new Agent({
        name: "rich-output-agent",
        instructions: "Use the tool",
        model: "gpt-4o-mini",
        tools: [new RichOutputTool()],
      }),
      messages: [stringToUserMessage("show me the image")],
      runtime,
    });

    const outputs: ThreadRunEvent[] = [];
    for await (const output of thread.run()) {
      outputs.push(output);
    }

    expect(outputs[1]).toMatchObject({
      role: "toolResult",
      toolName: "rich-output",
      content: [
        { type: "text", text: "Image attached" },
        { type: "image", data: "ZmFrZS1pbWFnZQ==", mimeType: "image/png" },
      ],
      details: {
        kind: "preview",
      },
    });
  });
});
