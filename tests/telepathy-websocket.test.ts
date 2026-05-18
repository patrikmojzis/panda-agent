import {describe, expect, it} from "vitest";

import {
  compactTelepathyCloseReason,
  createTelepathySocketBudget,
  isTelepathyUpgradeRequestAllowed,
  parseTelepathySocketReceiverMessage,
  parseTelepathySocketJson,
} from "../src/integrations/telepathy/websocket.js";

function upgradeRequest(input: {
  origin?: string | string[];
  url?: string;
}) {
  return {
    headers: input.origin === undefined ? {} : {origin: input.origin},
    url: input.url ?? "/telepathy",
  };
}

describe("telepathy websocket transport helpers", () => {
  it("allows only the configured path and loopback browser origins", () => {
    expect(isTelepathyUpgradeRequestAllowed(upgradeRequest({}), "/telepathy")).toBe(true);
    expect(isTelepathyUpgradeRequestAllowed(upgradeRequest({
      origin: "http://localhost:3000",
    }), "/telepathy")).toBe(true);
    expect(isTelepathyUpgradeRequestAllowed(upgradeRequest({
      origin: "http://127.0.0.1:3000",
    }), "/telepathy")).toBe(true);

    expect(isTelepathyUpgradeRequestAllowed(upgradeRequest({
      origin: "https://example.com",
    }), "/telepathy")).toBe(false);
    expect(isTelepathyUpgradeRequestAllowed(upgradeRequest({
      origin: ["http://localhost:3000", "https://example.com"],
    }), "/telepathy")).toBe(false);
    expect(isTelepathyUpgradeRequestAllowed(upgradeRequest({
      url: "/wrong",
    }), "/telepathy")).toBe(false);
  });

  it("parses raw websocket JSON frames", () => {
    expect(parseTelepathySocketJson(Buffer.from("{\"ok\":true}", "utf8"))).toEqual({
      ok: true,
    });
    expect(parseTelepathySocketJson([
      Buffer.from("{\"ok\":", "utf8"),
      Buffer.from("true}", "utf8"),
    ])).toEqual({
      ok: true,
    });
    expect(() => parseTelepathySocketJson(Buffer.from("not-json", "utf8")))
      .toThrow("Telepathy receiver sent invalid JSON.");
  });

  it("parses websocket receiver messages at the socket seam", () => {
    expect(parseTelepathySocketReceiverMessage(Buffer.from(JSON.stringify({
      type: "device.hello",
      agentKey: "panda",
      deviceId: "home-mac",
      token: "token-1",
    }), "utf8")).message).toMatchObject({
      type: "device.hello",
      agentKey: "panda",
      deviceId: "home-mac",
      token: "token-1",
    });

    expect(() => parseTelepathySocketReceiverMessage(Buffer.from(JSON.stringify({
      type: "device.hello",
      requestId: "hello-1",
    }), "utf8"))).toThrow("Invalid telepathy receiver message");
  });

  it("enforces message count budget per socket window", () => {
    const consume = createTelepathySocketBudget();
    for (let index = 0; index < 60; index += 1) {
      expect(consume(Buffer.from("{}", "utf8"))).toBeNull();
    }

    expect(consume(Buffer.from("{}", "utf8"))).toBe("Telepathy message rate limit exceeded.");
  });

  it("compacts close reasons to a websocket-safe byte length", () => {
    const compact = compactTelepathyCloseReason("x".repeat(200));

    expect(Buffer.byteLength(compact, "utf8")).toBeLessThanOrEqual(121);
    expect(compact.endsWith("...")).toBe(true);
  });
});
