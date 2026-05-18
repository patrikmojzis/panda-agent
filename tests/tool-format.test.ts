import type {ToolResultMessage} from "@mariozechner/pi-ai";
import {describe, expect, it} from "vitest";

import {formatToolResultFallback} from "../src/kernel/agent/tool.js";

function toolResult(params: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "example",
    content: [],
    isError: false,
    timestamp: Date.now(),
    ...params,
  };
}

describe("tool result formatting", () => {
  it("formats trimmed text and image parts before falling back to details", () => {
    expect(formatToolResultFallback(toolResult({
      content: [
        {type: "text", text: " first "},
        {type: "text", text: ""},
        {type: "image", data: "base64", mimeType: "image/png"},
        {type: "text", text: "second"},
      ],
      details: {ignored: true},
    }))).toBe("first\n\n[image attached]\n\nsecond");
  });

  it("falls back to details or status text when no visible content exists", () => {
    expect(formatToolResultFallback(toolResult({details: {status: "ok"}}))).toBe("{\n  \"status\": \"ok\"\n}");
    expect(formatToolResultFallback(toolResult())).toBe("Tool completed.");
    expect(formatToolResultFallback(toolResult({isError: true}))).toBe("Tool failed.");
  });
});
