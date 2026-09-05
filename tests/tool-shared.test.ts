import {describe, expect, it} from "vitest";

import {ToolError} from "../src/kernel/agent/exceptions.js";
import type {ToolResultPayload} from "../src/kernel/agent/types.js";
import {
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
});
