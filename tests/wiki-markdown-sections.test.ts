import {describe, expect, it} from "vitest";

import {buildMarkdownPageWithSection, upsertMarkdownSection,} from "../src/integrations/wiki/markdown-sections.js";

describe("wiki markdown sections", () => {
  it("replaces an existing ## section and its nested headings", () => {
    const result = upsertMarkdownSection(
      [
        "# Profile",
        "",
        "## Facts",
        "",
        "Old facts.",
        "",
        "### Details",
        "",
        "Old details.",
        "",
        "## Links",
        "",
        "- one",
      ].join("\n"),
      "Facts",
      [
        "New facts.",
        "",
        "- clean",
        "- predictable",
      ].join("\n"),
    );

    expect(result).toEqual({
      action: "replaced",
      content: [
        "# Profile",
        "",
        "## Facts",
        "",
        "New facts.",
        "",
        "- clean",
        "- predictable",
        "",
        "## Links",
        "",
        "- one",
      ].join("\n"),
    });
  });

  it("appends a missing ## section to the end of the document", () => {
    const result = upsertMarkdownSection(
      [
        "# Profile",
        "",
        "## Summary",
        "",
        "Already here.",
      ].join("\n"),
      "Facts",
      "- likes tea",
    );

    expect(result).toEqual({
      action: "appended",
      content: [
        "# Profile",
        "",
        "## Summary",
        "",
        "Already here.",
        "",
        "## Facts",
        "",
        "- likes tea",
      ].join("\n"),
    });
  });

  it("builds a simple new page scaffold with one section", () => {
    expect(buildMarkdownPageWithSection("Profile", "Facts", "- likes tea")).toBe(
      [
        "# Profile",
        "",
        "## Facts",
        "",
        "- likes tea",
      ].join("\n"),
    );
  });
});
