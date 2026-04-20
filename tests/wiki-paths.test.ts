import {describe, expect, it} from "vitest";

import {buildWikiPageAssetDirectory} from "../src/integrations/wiki/paths.js";

describe("wiki asset paths", () => {
  it("normalizes page-relative asset folders to wiki-safe slugs", () => {
    expect(buildWikiPageAssetDirectory(
      "agents/panda",
      "agents/panda/About Me/Headshots & Press",
    )).toBe("agents/panda/_assets/about-me/headshots-press");
  });

  it("uses the namespace asset root for the namespace page itself", () => {
    expect(buildWikiPageAssetDirectory("agents/panda", "agents/panda")).toBe("agents/panda/_assets");
  });
});
