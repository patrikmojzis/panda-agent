import {describe, expect, it} from "vitest";

import {retargetWikiLinks, rewriteRelativeWikiLinksForMovedPage,} from "../src/integrations/wiki/link-rewrite.js";

describe("wiki link rewrite helpers", () => {
  it("retargets absolute and relative wiki links while preserving suffixes", () => {
    const document = [
      "[Absolute](/agents/panda/profile#facts)",
      "[Locale](</en/agents/panda/profile?view=full#facts>)",
      "[Relative](../profile#facts)",
      "[External](https://example.com/profile)",
    ].join("\n");

    const rewritten = retargetWikiLinks(document, {
      fromPath: "agents/panda/profile",
      locale: "en",
      sourcePagePath: "agents/panda/notes/today",
      toPath: "agents/panda/memory/profile",
    });

    expect(rewritten.rewrittenLinks).toBe(3);
    expect(rewritten.content).toBe([
      "[Absolute](/agents/panda/memory/profile#facts)",
      "[Locale](</en/agents/panda/memory/profile?view=full#facts>)",
      "[Relative](../memory/profile#facts)",
      "[External](https://example.com/profile)",
    ].join("\n"));
  });

  it("rewrites reference-style links and skips fenced code blocks", () => {
    const document = [
      "[profile]: /agents/panda/profile",
      "",
      "```md",
      "[Inside Code](/agents/panda/profile)",
      "```",
    ].join("\n");

    const rewritten = retargetWikiLinks(document, {
      fromPath: "agents/panda/profile",
      locale: "en",
      sourcePagePath: "agents/panda/index",
      toPath: "agents/panda/memory/profile",
    });

    expect(rewritten.rewrittenLinks).toBe(1);
    expect(rewritten.content).toBe([
      "[profile]: /agents/panda/memory/profile",
      "",
      "```md",
      "[Inside Code](/agents/panda/profile)",
      "```",
    ].join("\n"));
  });

  it("skips inline code, indented code, html comments, and code tags", () => {
    const document = [
      "`[Inline Code](/agents/panda/profile)` and [Live](/agents/panda/profile)",
      "    [Indented Code](/agents/panda/profile)",
      "<!-- [Commented](/agents/panda/profile) --> [Visible](/agents/panda/profile)",
      "<code>[Tagged](/agents/panda/profile)</code> [Outside](/agents/panda/profile)",
    ].join("\n");

    const rewritten = retargetWikiLinks(document, {
      fromPath: "agents/panda/profile",
      locale: "en",
      sourcePagePath: "agents/panda/index",
      toPath: "agents/panda/memory/profile",
    });

    expect(rewritten.rewrittenLinks).toBe(3);
    expect(rewritten.content).toBe([
      "`[Inline Code](/agents/panda/profile)` and [Live](/agents/panda/memory/profile)",
      "    [Indented Code](/agents/panda/profile)",
      "<!-- [Commented](/agents/panda/profile) --> [Visible](/agents/panda/memory/profile)",
      "<code>[Tagged](/agents/panda/profile)</code> [Outside](/agents/panda/memory/profile)",
    ].join("\n"));
  });

  it("skips multi-line html comments and code tags while still rewriting content around them", () => {
    const document = [
      "Before [Live](/agents/panda/profile)",
      "<!--",
      "[Commented](/agents/panda/profile)",
      "-->",
      "<code>",
      "[Tagged](/agents/panda/profile)",
      "</code>",
      "After [Live](/agents/panda/profile)",
    ].join("\n");

    const rewritten = retargetWikiLinks(document, {
      fromPath: "agents/panda/profile",
      locale: "en",
      sourcePagePath: "agents/panda/index",
      toPath: "agents/panda/memory/profile",
    });

    expect(rewritten.rewrittenLinks).toBe(2);
    expect(rewritten.content).toBe([
      "Before [Live](/agents/panda/memory/profile)",
      "<!--",
      "[Commented](/agents/panda/profile)",
      "-->",
      "<code>",
      "[Tagged](/agents/panda/profile)",
      "</code>",
      "After [Live](/agents/panda/memory/profile)",
    ].join("\n"));
  });

  it("rewrites moved-page relative links so they keep pointing at the same targets", () => {
    const document = [
      "[Profile](../profile)",
      "[Checklist](./checklist)",
      "[Absolute](/agents/panda/handbook)",
    ].join("\n");

    const rewritten = rewriteRelativeWikiLinksForMovedPage(document, {
      destinationPagePath: "agents/panda/journal/2026/today",
      locale: "en",
      sourcePagePath: "agents/panda/notes/today",
    });

    expect(rewritten.rewrittenLinks).toBe(2);
    expect(rewritten.content).toBe([
      "[Profile](../../profile)",
      "[Checklist](../../notes/checklist)",
      "[Absolute](/agents/panda/handbook)",
    ].join("\n"));
  });
});
