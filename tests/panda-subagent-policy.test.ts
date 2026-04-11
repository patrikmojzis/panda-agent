import {describe, expect, it} from "vitest";

import {BashTool, filterToolsForSubagentRole, MediaTool, WebFetchTool,} from "../src/index.js";

describe("Panda subagent policy", () => {
  it("keeps web_fetch available to the explore role", () => {
    const tools = filterToolsForSubagentRole(
      [new BashTool(), new MediaTool(), new WebFetchTool()],
      "explore",
    );

    expect(tools.map((tool) => tool.name)).toEqual(["bash", "view_media", "web_fetch"]);
  });
});
