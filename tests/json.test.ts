import {describe, expect, it} from "vitest";

import {
  isJsonObject,
  isJsonValue,
  normalizeToJsonValue,
  readOptionalJsonValue,
  requireJsonValue,
  stableStringify,
  stringifyOptionalJsonValue,
} from "../src/lib/json.js";

describe("JSON helpers", () => {
  it("recognizes JSON values and objects", () => {
    expect(isJsonValue({
      ok: true,
      nested: [1, "two", null],
    })).toBe(true);
    expect(isJsonObject({
      ok: true,
    })).toBe(true);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonObject(["not", "an", "object"])).toBe(false);
    expect(isJsonObject(new Date("2026-05-13T12:00:00.000Z"))).toBe(false);
    expect(isJsonObject(Buffer.from("not-json"))).toBe(false);
  });

  it("returns labeled JSON values for row parsers", () => {
    expect(requireJsonValue({ok: true}, "Metadata")).toEqual({ok: true});
    expect(readOptionalJsonValue(null, "Metadata")).toBeUndefined();
    expect(stringifyOptionalJsonValue(undefined, "Metadata")).toBeNull();
    expect(stringifyOptionalJsonValue({ok: true}, "Metadata")).toBe("{\"ok\":true}");
    expect(() => requireJsonValue(Number.NaN, "Metadata")).toThrow(
      "Metadata must be JSON-serializable.",
    );
  });

  it("keeps stable object key ordering", () => {
    expect(stableStringify({b: 2, a: 1})).toBe("{\"a\":1,\"b\":2}");
  });

  it("normalizes runtime values into JSON values", () => {
    expect(normalizeToJsonValue({
      id: {
        toHexString: () => "507f1f77bcf86cd799439011",
      },
      createdAt: new Date("2026-05-13T12:00:00.000Z"),
      bytes: Buffer.from("hi", "utf8"),
      count: 123n,
      skipped: undefined,
    })).toEqual({
      id: "507f1f77bcf86cd799439011",
      createdAt: "2026-05-13T12:00:00.000Z",
      bytes: Buffer.from("hi", "utf8").toString("base64"),
      count: "123",
    });
  });
});
