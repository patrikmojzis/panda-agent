import {describe, expect, it} from "vitest";

import {renderResumeHint} from "../src/ui/tui/exit-hint.js";

describe("renderResumeHint", () => {
  it("renders a full-width resume footer", () => {
    const threadId = "374e4333-c8b1-48df-8b4a-5a11bca5d15a";
    const width = 72;

    expect(renderResumeHint(threadId, width)).toBe(
      `Resume this session with:${"─".repeat(width - "Resume this session with:".length)}\n` +
      `panda --resume ${threadId}`,
    );
  });

  it("keeps the separator visible on narrow terminals", () => {
    expect(renderResumeHint("thread-123", 8)).toBe(
      "Resume this session with:─\n" +
      "panda --resume thread-123",
    );
  });
});
