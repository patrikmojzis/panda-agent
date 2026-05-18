import {describe, expect, test} from "vitest";

import {
  optionalNonEmptyString,
  optionalTrimmedString,
  requireNonEmptyString,
  requireTrimmedString,
  uniqueTrimmedStrings,
} from "../src/lib/strings.js";

describe("string validation helpers", () => {
  test("requireNonEmptyString trims present values and preserves caller errors", () => {
    expect(requireNonEmptyString("  value  ", "missing")).toBe("value");
    expect(() => requireNonEmptyString("  ", "missing")).toThrow("missing");
    expect(() => requireNonEmptyString(123, "missing")).toThrow("missing");
  });

  test("requireTrimmedString preserves separate type and empty diagnostics", () => {
    expect(requireTrimmedString("  value  ", "bad type", "empty")).toBe("value");
    expect(() => requireTrimmedString(123, "bad type", "empty")).toThrow("bad type");
    expect(() => requireTrimmedString("  ", "bad type", "empty")).toThrow("empty");
  });

  test("optionalNonEmptyString accepts absent values but rejects invalid present values", () => {
    expect(optionalNonEmptyString(null, "missing")).toBeUndefined();
    expect(optionalNonEmptyString(undefined, "missing")).toBeUndefined();
    expect(optionalNonEmptyString("  value  ", "missing")).toBe("value");
    expect(() => optionalNonEmptyString("  ", "missing")).toThrow("missing");
    expect(() => optionalNonEmptyString(false, "missing")).toThrow("missing");
  });

  test("optionalTrimmedString treats blank strings as absent but rejects non-strings", () => {
    expect(optionalTrimmedString(null, "bad type")).toBeUndefined();
    expect(optionalTrimmedString("  ", "bad type")).toBeUndefined();
    expect(optionalTrimmedString("  value  ", "bad type")).toBe("value");
    expect(() => optionalTrimmedString(false, "bad type")).toThrow("bad type");
  });

  test("uniqueTrimmedStrings drops blanks and preserves first-seen order", () => {
    expect(uniqueTrimmedStrings([" alpha ", "", "beta", "alpha", " beta "])).toEqual(["alpha", "beta"]);
  });
});
