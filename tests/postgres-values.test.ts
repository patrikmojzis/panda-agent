import {describe, expect, test} from "vitest";

import {
  nullableTimestampMillis,
  optionalTimestampMillis,
  requireTimestampMillis,
  toMillis,
} from "../src/lib/postgres-values.js";

describe("Postgres timestamp value helpers", () => {
  test("convert trusted Postgres timestamp values to epoch millis", () => {
    expect(toMillis(123)).toBe(123);
    expect(toMillis(new Date(456))).toBe(456);
  });

  test("reject unsupported timestamp row values without parsing strings", () => {
    expect(Number.isNaN(toMillis("2026-01-01T00:00:00.000Z"))).toBe(true);
    expect(() => requireTimestampMillis("bad", "caller timestamp error")).toThrow(
      "caller timestamp error",
    );
  });

  test("read nullable timestamps as optional or null according to caller contract", () => {
    expect(optionalTimestampMillis(null, "unused")).toBeUndefined();
    expect(optionalTimestampMillis(undefined, "unused")).toBeUndefined();
    expect(optionalTimestampMillis(new Date(789), "unused")).toBe(789);
    expect(nullableTimestampMillis(null, "unused")).toBeNull();
    expect(nullableTimestampMillis(undefined, "unused")).toBeNull();
    expect(nullableTimestampMillis(new Date(987), "unused")).toBe(987);
  });
});
