import {describe, expect, it} from "vitest";

import {buildDefaultAgentToolsetsFromRegistry, createDefaultAgentToolRegistry,} from "../src/panda/definition.js";

describe("default agent specialist toolsets", () => {
  function createBaseToolsets() {
    return buildDefaultAgentToolsetsFromRegistry(createDefaultAgentToolRegistry());
  }

  it("builds the workspace toolset with media only", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.workspace.map((tool) => tool.name)).toEqual([
      "view_media",
    ]);
  });

  it("keeps command-backed memory out of the native memory toolset", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.memory.map((tool) => tool.name)).toEqual([]);
  });

  it("gives the browser subagent browser plus media artifact inspection", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.browser.map((tool) => tool.name)).toEqual([
      "view_media",
      "browser",
    ]);
  });

  it("gives the skill maintainer media artifact inspection natively", () => {
    const toolsets = createBaseToolsets();

    expect(toolsets.skill_maintainer.map((tool) => tool.name)).toEqual([
      "view_media",
    ]);
  });
});
