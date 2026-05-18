import {describe, expect, it} from "vitest";

import {ToolError} from "../src/kernel/agent/exceptions.js";
import type {ToolResultPayload} from "../src/kernel/agent/types.js";
import {
  readRequiredAgentSessionToolScope,
  readRequiredSessionToolScope,
  requireJsonObject,
  serializeToolResultForBackgroundJob,
} from "../src/panda/tools/shared.js";

describe("tool shared helpers", () => {
  it("serializes background tool payload text and details", () => {
    const payload = {
      content: [
        {type: "text", text: " first "},
        {type: "text", text: ""},
        {type: "text", text: "second"},
      ],
      details: {
        status: "done",
        count: 2,
      },
    } satisfies ToolResultPayload;

    expect(serializeToolResultForBackgroundJob(payload)).toEqual({
      contentText: "first\n\nsecond",
      details: {
        status: "done",
        count: 2,
      },
    });
  });

  it("rejects non-json detail objects before persistence", () => {
    expect(() => requireJsonObject({count: Number.NaN}, "bad details"))
      .toThrow(new ToolError("bad details"));
  });

  it("rejects bad background result details", () => {
    const payload = {
      content: [{type: "text", text: "done"}],
      details: {count: Number.NaN},
    } satisfies ToolResultPayload;

    expect(() => serializeToolResultForBackgroundJob(payload))
      .toThrow(new ToolError("Background tool result details must be a JSON object."));
  });

  it("reads runtime tool scope and current input ids", () => {
    expect(readRequiredAgentSessionToolScope({
      agentKey: " panda ",
      sessionId: " session-1 ",
      currentInput: {
        identityId: "identity-1",
      },
    }, "missing scope")).toEqual({
      agentKey: "panda",
      sessionId: "session-1",
      identityId: "identity-1",
    });

    expect(readRequiredSessionToolScope({
      sessionId: "session-1",
      currentInput: {
        identityId: "identity-1",
        messageId: "message-1",
      },
    }, "missing session")).toEqual({
      sessionId: "session-1",
      identityId: "identity-1",
      messageId: "message-1",
    });
  });
});
