import {describe, expect, it} from "vitest";

import {resolveWikiInputPath} from "../src/integrations/wiki/namespace-policy.js";
import {buildWikiPageAssetDirectory} from "../src/integrations/wiki/paths.js";

const NAMESPACE = "agents/panda";

describe("agent-facing wiki path resolution", () => {
  it.each([
    ["profile", "agents/panda/profile"],
    ["notes/today", "agents/panda/notes/today"],
    ["_archive/2026/profile", "agents/panda/_archive/2026/profile"],
    [NAMESPACE, NAMESPACE],
    ["agents/panda/profile", "agents/panda/profile"],
  ])("resolves page path %s to %s", (inputPath, resolvedPath) => {
    expect(resolveWikiInputPath(inputPath, NAMESPACE, "page")).toEqual({inputPath, resolvedPath});
  });

  it("resolves relative assets only inside the current _assets root", () => {
    expect(resolveWikiInputPath("_assets/profile/photo.png", NAMESPACE, "asset")).toEqual({
      inputPath: "_assets/profile/photo.png",
      resolvedPath: "agents/panda/_assets/profile/photo.png",
    });
    expect(() => resolveWikiInputPath("profile/photo.png", NAMESPACE, "asset")).toThrowError(
      "The Wiki asset path is outside the current agent asset namespace.",
    );
  });

  it.each([
    "agents/other/profile",
    "agents/other/_assets/profile/photo.png",
  ])("rejects explicit cross-agent path %s", (inputPath) => {
    expect(() => resolveWikiInputPath(inputPath, NAMESPACE, "page")).toThrowError(
      "The Wiki path is outside the current agent namespace.",
    );
  });

  it.each(["", "/profile", "profile/", "notes//today", ".", "..", "notes/../today"])(
    "rejects unsafe path %j",
    (inputPath) => {
      expect(() => resolveWikiInputPath(inputPath, NAMESPACE, "page")).toThrow();
    },
  );
});

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
