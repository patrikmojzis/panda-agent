import type {AssistantMessage, ToolResultMessage} from "@mariozechner/pi-ai";
import {describe, expect, it, vi} from "vitest";

import {stringToUserMessage} from "../src/index.js";
import {
  collectImageBriefTranscriptMessages,
  composeImagePrompt,
  renderImageBriefTranscript,
  resolveImageContextEnabled,
} from "../src/panda/tools/image-generation/brief.js";

function assistantText(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{type: "text", text}],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function assistantImageGenerateCall(args: Record<string, unknown>): AssistantMessage {
  return {
    ...assistantText(""),
    content: [{
      type: "toolCall",
      id: "call-image",
      name: "image_generate",
      arguments: args,
    }],
    stopReason: "toolUse",
  };
}

function toolNoise(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{type: "text", text: "massive tool noise"}],
    isError: false,
    timestamp: Date.now(),
  };
}

function imageGenerateResult(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-image",
    toolName: "image_generate",
    content: [{
      type: "text",
      text: "Generated 1 image.\nImage 1: /tmp/panda/generated-red-square.png",
    }],
    details: {
      images: [{
        path: "/tmp/panda/generated-red-square.png",
        revisedPrompt: "A centered red square icon on a white background.",
        mimeType: "image/png",
      }],
      settings: {
        size: "1024x1024",
        quality: "low",
        outputFormat: "png",
      },
    },
    isError: false,
    timestamp: Date.now(),
  };
}

function viewMediaResult(): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-view",
    toolName: "view_media",
    content: [{
      type: "text",
      text: "Image file: generated-red-square.png\nDimensions: 1024 x 1024",
    }],
    details: {
      path: "/tmp/panda/generated-red-square.png",
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    },
    isError: false,
    timestamp: Date.now(),
  };
}

describe("image brief composition", () => {
  it("defaults context on but respects env and per-call overrides", () => {
    expect(resolveImageContextEnabled({env: {}})).toBe(true);
    expect(resolveImageContextEnabled({env: {PANDA_IMAGE_CONTEXT_DEFAULT: "off"}})).toBe(false);
    expect(resolveImageContextEnabled({
      requested: true,
      env: {PANDA_IMAGE_CONTEXT_DEFAULT: "off"},
    })).toBe(true);
    expect(resolveImageContextEnabled({requested: false, env: {}})).toBe(false);
  });

  it("keeps only the latest visible user and assistant messages", () => {
    const messages = [
      ...Array.from({length: 20}, (_, index) => stringToUserMessage(`user ${index}`)),
      toolNoise(),
      assistantText("keep assistant note"),
    ];

    const transcript = collectImageBriefTranscriptMessages(messages);

    expect(transcript).toHaveLength(16);
    expect(transcript[0]).toMatchObject({role: "user", text: "user 5"});
    expect(transcript.at(-1)).toMatchObject({role: "assistant", text: "keep assistant note"});
    expect(transcript.some((entry) => entry.text.includes("massive tool noise"))).toBe(false);
  });

  it("asks the brief model for a clean context and caps the compiled prompt", async () => {
    const complete = vi.fn().mockResolvedValue(assistantText("Keep the red jacket and rainy neon street."));
    const result = await composeImagePrompt({
      prompt: "Draw the final poster.",
      messages: [
        stringToUserMessage("Earlier: character has a red jacket."),
        toolNoise(),
        assistantText("We settled on a rainy neon street."),
      ],
      contextEnabled: true,
      env: {
        ...process.env,
        PANDA_IMAGE_BRIEF_MODEL: "openai-codex/gpt-5.4-mini",
      },
      runtime: {complete},
    });

    expect(result.contextUsed).toBe(true);
    expect(result.contextMessages).toBe(2);
    expect(result.compiledPrompt).toContain("Conversation brief:");
    expect(result.compiledPrompt).toContain("Keep the red jacket");
    expect(result.compiledPrompt.length).toBeLessThanOrEqual(12_000);
    const request = complete.mock.calls[0]?.[0];
    expect(request.context.messages[0].content).not.toContain("massive tool noise");
  });

  it("keeps prior image generation state for iterative edits without unrelated tool noise", () => {
    const transcript = collectImageBriefTranscriptMessages([
      stringToUserMessage("Make a tiny red square icon."),
      assistantImageGenerateCall({
        prompt: "tiny red square icon on white background",
        size: "1024x1024",
        quality: "low",
        outputFormat: "png",
      }),
      imageGenerateResult(),
      viewMediaResult(),
      toolNoise(),
      stringToUserMessage("No, make it blue instead."),
    ]);
    const rendered = renderImageBriefTranscript(transcript);

    expect(rendered).toContain("image_generate request");
    expect(rendered).toContain("tiny red square icon on white background");
    expect(rendered).toContain("image_generate result");
    expect(rendered).toContain("/tmp/panda/generated-red-square.png");
    expect(rendered).toContain("A centered red square icon");
    expect(rendered).toContain("view_media result");
    expect(rendered).toContain("width: 1024");
    expect(rendered).not.toContain("massive tool noise");
  });
});
