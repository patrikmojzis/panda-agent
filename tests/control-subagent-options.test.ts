import {describe, expect, it} from "vitest";

import {
  filterKnownSubagentToolGroups,
  subagentToolGroupOptions,
} from "../apps/control-ui/src/features/control/agent/subagent-options.js";
import {subagentToFormValues} from "../apps/control-ui/src/features/control/forms/form-values.js";

describe("Control subagent tool group options", () => {
  it("matches the supported tool group surface", () => {
    expect(subagentToolGroupOptions.map((option) => option.value)).toEqual([
      "core",
      "mcp",
      "internet",
      "memory",
      "skill_maintenance",
      "operate",
      "communicate_human",
    ]);
  });

  it("filters unknown API values and removes duplicates", () => {
    expect(filterKnownSubagentToolGroups(["core", "unknown", "core", "internet"])).toEqual([
      "core",
      "internet",
    ]);
  });

  it("falls back to core when an API row has no supported tool groups", () => {
    expect(subagentToFormValues({
      slug: "reviewer",
      description: "Review changes.",
      toolGroups: ["unknown"],
      source: "custom",
      enabled: true,
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
    }).toolGroups).toEqual(["core"]);
  });
});
