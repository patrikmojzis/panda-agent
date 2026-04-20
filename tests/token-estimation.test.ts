import {describe, expect, it, vi} from "vitest";
import type {ToolResultMessage} from "@mariozechner/pi-ai";

import {estimateReplayMessageTokens, estimateVisibleMessageTokens,} from "../src/kernel/transcript/token-estimation.js";
import {withArtifactDetails} from "../src/kernel/agent/tool-artifacts.js";
import {estimateTranscriptTokens} from "../src/kernel/transcript/compaction.js";

const ONE_PIXEL_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO6p6WQAAAAASUVORK5CYII=";

describe("estimateVisibleMessageTokens", () => {
  it("does not feed inline image base64 into the text estimator", () => {
    const estimateTextTokens = vi.fn((text: string) => text.length);
    const tokens = estimateVisibleMessageTokens({
      role: "user",
      content: [
        {type: "text", text: "caption"},
        {type: "image", data: "A".repeat(20_000), mimeType: "image/png"},
      ],
      timestamp: 1,
    }, estimateTextTokens);

    expect(estimateTextTokens).toHaveBeenCalledTimes(1);
    expect(estimateTextTokens).toHaveBeenCalledWith("caption");
    expect(tokens).toBeGreaterThan(1_000);
  });

  it("does not count stripped tool images from artifact metadata by default", () => {
    const baselineMessage: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "view_media",
      content: [{type: "text", text: "Image file: cat.png"}],
      isError: false,
      timestamp: 1,
    };
    const artifactMessage: ToolResultMessage = {
      ...baselineMessage,
      details: withArtifactDetails({}, {
        kind: "image",
        source: "view_media",
        path: "/tmp/cat.png",
        mimeType: "image/png",
        width: 200,
        height: 100,
      }),
    };

    expect(estimateVisibleMessageTokens(artifactMessage)).toBe(estimateVisibleMessageTokens(baselineMessage));
  });

  it("counts stripped tool images from artifact metadata during replay estimation", () => {
    const baselineMessage: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "view_media",
      content: [{type: "text", text: "Image file: cat.png"}],
      isError: false,
      timestamp: 1,
    };
    const artifactMessage: ToolResultMessage = {
      ...baselineMessage,
      details: withArtifactDetails({}, {
        kind: "image",
        source: "view_media",
        path: "/tmp/cat.png",
        mimeType: "image/png",
        width: 200,
        height: 100,
      }),
    };

    expect(estimateReplayMessageTokens(artifactMessage)).toBe(estimateVisibleMessageTokens(baselineMessage) + 85);
  });

  it("sniffs inline image dimensions from base64 when metadata is absent", () => {
    expect(estimateVisibleMessageTokens({
      role: "user",
      content: [{type: "image", data: ONE_PIXEL_PNG_BASE64, mimeType: "image/png"}],
      timestamp: 1,
    })).toBe(85);
  });

  it("counts stripped pdf previews from artifact metadata during replay estimation", () => {
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "view_media",
      content: [{type: "text", text: "PDF file: report.pdf"}],
      isError: false,
      timestamp: 1,
      details: withArtifactDetails({}, {
        kind: "pdf",
        source: "view_media",
        path: "/tmp/report.pdf",
        mimeType: "application/pdf",
        preview: {
          kind: "image",
          path: "/tmp/report-preview.png",
          mimeType: "image/png",
          width: 1600,
          height: 1200,
        },
      }),
    };

    expect(estimateVisibleMessageTokens(message)).toBeLessThan(estimateReplayMessageTokens(message));
    expect(estimateReplayMessageTokens(message)).toBeGreaterThanOrEqual(1_600);
  });

  it("lets transcript budgeting opt into replay-aware artifact counting", () => {
    const transcript = [{
      id: "message-1",
      threadId: "thread-1",
      sequence: 1,
      origin: "runtime" as const,
      source: "tool:view_media",
      message: {
        role: "toolResult" as const,
        toolCallId: "call-1",
        toolName: "view_media",
        content: [{type: "text" as const, text: "Image file: cat.png"}],
        isError: false,
        timestamp: 1,
        details: withArtifactDetails({}, {
          kind: "image",
          source: "view_media",
          path: "/tmp/cat.png",
          mimeType: "image/png",
          width: 200,
          height: 100,
        }),
      },
      createdAt: 1,
    }];

    expect(estimateTranscriptTokens(transcript)).toBeLessThan(estimateTranscriptTokens(transcript, {
      replayToolArtifacts: true,
    }));
  });
});
