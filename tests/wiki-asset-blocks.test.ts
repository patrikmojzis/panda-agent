import {describe, expect, it} from "vitest";

import {buildMarkdownImageAssetBlock, upsertMarkdownSectionImageAsset,} from "../src/integrations/wiki/asset-blocks.js";

describe("wiki asset blocks", () => {
  it("builds a managed markdown image block", () => {
    expect(buildMarkdownImageAssetBlock({
      slot: "profile-photo",
      assetPath: "agents/panda/_assets/profile/profile-photo.png",
      alt: "Profile photo",
      caption: "Panda, but photogenic.",
    })).toBe([
      '<!-- panda:asset slot="profile-photo" path="agents/panda/_assets/profile/profile-photo.png" -->',
      "![Profile photo](/agents/panda/_assets/profile/profile-photo.png)",
      "_Panda, but photogenic._",
      "<!-- /panda:asset -->",
    ].join("\n"));
  });

  it("replaces an existing managed slot inside a section", () => {
    const result = upsertMarkdownSectionImageAsset(
      [
        "# Profile",
        "",
        "## Facts",
        "",
        "Keeps a low profile.",
        "",
        '<!-- panda:asset slot="profile-photo" path="agents/panda/_assets/profile/old.png" -->',
        "![Old photo](/agents/panda/_assets/profile/old.png)",
        "<!-- /panda:asset -->",
        "",
        "## Links",
        "",
        "- one",
      ].join("\n"),
      "Facts",
      {
        slot: "profile-photo",
        assetPath: "agents/panda/_assets/profile/new.png",
        alt: "New photo",
        caption: "Freshly updated.",
      },
    );

    expect(result).toEqual({
      sectionAction: "replaced",
      blockAction: "replaced",
      content: [
        "# Profile",
        "",
        "## Facts",
        "",
        "Keeps a low profile.",
        "",
        '<!-- panda:asset slot="profile-photo" path="agents/panda/_assets/profile/new.png" -->',
        "![New photo](/agents/panda/_assets/profile/new.png)",
        "_Freshly updated._",
        "<!-- /panda:asset -->",
        "",
        "## Links",
        "",
        "- one",
      ].join("\n"),
    });
  });

  it("appends a missing managed slot to the requested section", () => {
    const result = upsertMarkdownSectionImageAsset(
      [
        "# Profile",
        "",
        "## Facts",
        "",
        "Keeps a low profile.",
      ].join("\n"),
      "Facts",
      {
        slot: "profile-photo",
        assetPath: "agents/panda/_assets/profile/new.png",
        alt: "New photo",
      },
    );

    expect(result).toEqual({
      sectionAction: "replaced",
      blockAction: "appended",
      content: [
        "# Profile",
        "",
        "## Facts",
        "",
        "Keeps a low profile.",
        "",
        '<!-- panda:asset slot="profile-photo" path="agents/panda/_assets/profile/new.png" -->',
        "![New photo](/agents/panda/_assets/profile/new.png)",
        "<!-- /panda:asset -->",
      ].join("\n"),
    });
  });
});
