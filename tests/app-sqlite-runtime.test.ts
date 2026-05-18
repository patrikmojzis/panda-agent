import {describe, expect, it} from "vitest";

import {normalizeSqlChangeCount} from "../src/integrations/apps/sqlite-runtime.js";

describe("app SQLite runtime", () => {
  it("normalizes SQLite change counts without numeric coercion", () => {
    expect(normalizeSqlChangeCount(0)).toBe(0);
    expect(normalizeSqlChangeCount(2)).toBe(2);
    expect(normalizeSqlChangeCount(3n)).toBe(3);

    expect(() => normalizeSqlChangeCount("4")).toThrow(
      "App action SQLite change count must be a non-negative safe integer.",
    );
    expect(() => normalizeSqlChangeCount(Number.NaN)).toThrow(
      "App action SQLite change count must be a non-negative safe integer.",
    );
    expect(() => normalizeSqlChangeCount(-1n)).toThrow(
      "App action SQLite change count must be a non-negative safe integer.",
    );
  });
});
