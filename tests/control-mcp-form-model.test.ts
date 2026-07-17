import {describe, expect, it} from "vitest";

import {
  formatMcpArgs,
  parseMcpArgs,
} from "../apps/control-ui/src/features/control/agent/mcp-form-model.js";

describe("Control MCP argument form model", () => {
  it("round-trips empty and newline-containing arguments without changing them", () => {
    const args = ["", "ordinary", "line one\nline two", " trailing "];
    expect(parseMcpArgs(formatMcpArgs(args))).toEqual(args);
  });

  it.each(["{}", "[1]", "[\"ok\", null]"])("rejects non-string argument arrays: %s", (value) => {
    expect(() => parseMcpArgs(value)).toThrow("Arguments must be a JSON array of strings.");
  });
});
