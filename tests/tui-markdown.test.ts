import {describe, expect, it} from "vitest";

import {renderTranscriptEntries} from "../src/features/tui/transcript.js";
import {renderMarkdownLines} from "../src/features/tui/markdown.js";

describe("renderTranscriptEntries assistant markdown", () => {
  it("preserves assistant markdown structure instead of flattening whitespace", () => {
    const entries = renderTranscriptEntries(
      {
        role: "assistant",
        content: [{
          type: "text",
          text: "## Plan\n\n- first\n- second",
        }],
      } as any,
      { source: "assistant" },
    );

    expect(entries).toEqual([{
      role: "assistant",
      title: "Agent",
      body: "## Plan\n\n- first\n- second",
    }]);
  });
});

describe("renderMarkdownLines", () => {
  it("renders markdown structure for headings, lists, and code blocks", () => {
    const lines = renderMarkdownLines(
      [
        "## Plan",
        "",
        "- first item",
        "- second item",
        "",
        "```ts",
        "const value = 42;",
        "```",
      ].join("\n"),
      40,
    );

    expect(lines.map((line) => line.plain)).toEqual([
      "Plan",
      "",
      "- first item",
      "- second item",
      "",
      "  const value = 42;",
    ]);
  });

  it("word-wraps plain assistant text cleanly", () => {
    const lines = renderMarkdownLines(
      "A paragraph with several words that should wrap cleanly.",
      20,
    );

    expect(lines.map((line) => line.plain)).toEqual([
      "A paragraph with",
      "several words that",
      "should wrap cleanly.",
    ]);
  });

  it("keeps link labels readable while preserving the href", () => {
    const lines = renderMarkdownLines(
      "[docs](https://example.com/docs)",
      60,
    );

    expect(lines.map((line) => line.plain)).toEqual([
      "docs (https://example.com/docs)",
    ]);
  });
});
