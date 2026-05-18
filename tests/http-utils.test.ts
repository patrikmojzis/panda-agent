import {describe, expect, it} from "vitest";

import {isLoopbackHttpHostname, normalizeHttpHostname} from "../src/lib/http.js";

describe("HTTP host helpers", () => {
  it("normalizes hostnames before security comparisons", () => {
    expect(normalizeHttpHostname("LOCALHOST.")).toBe("localhost");
    expect(normalizeHttpHostname("[::1]")).toBe("::1");
  });

  it("recognizes loopback hostnames and addresses without accepting private networks", () => {
    expect(isLoopbackHttpHostname("localhost")).toBe(true);
    expect(isLoopbackHttpHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHttpHostname("[::1]")).toBe(true);
    expect(isLoopbackHttpHostname("::ffff:127.0.0.1")).toBe(true);

    expect(isLoopbackHttpHostname("10.0.0.1")).toBe(false);
    expect(isLoopbackHttpHostname("example.com")).toBe(false);
  });
});
