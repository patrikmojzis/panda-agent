import {describe, expect, it} from "vitest";

import {readTcpPort, requireNonNegativeInteger} from "../src/lib/numbers.js";

describe("number helpers", () => {
  it("reads TCP ports with explicit ephemeral-port opt in", () => {
    expect(readTcpPort("5432")).toBe(5432);
    expect(readTcpPort(65_535)).toBe(65_535);
    expect(readTcpPort("0")).toBeUndefined();
    expect(readTcpPort("0", {allowZero: true})).toBe(0);

    expect(readTcpPort("65536")).toBeUndefined();
    expect(readTcpPort("1.5")).toBeUndefined();
    expect(readTcpPort("nope")).toBeUndefined();
  });

  it("requires non-negative integers without string coercion", () => {
    expect(requireNonNegativeInteger(1, "Count")).toBe(1);
    expect(() => requireNonNegativeInteger("1", "Count")).toThrow(
      "Count must be a non-negative integer.",
    );
    expect(() => requireNonNegativeInteger(-1, "Count")).toThrow(
      "Count must be a non-negative integer.",
    );
  });
});
