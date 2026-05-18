import {describe, expect, it} from "vitest";

import {
  isGatewayClientAllowed,
  parseGatewayIpList,
  resolveGatewayClientAddress,
  resolveGatewayNetworkControls,
} from "../src/integrations/gateway/network-controls.js";

describe("gateway network controls", () => {
  it("trusts X-Forwarded-For only when the direct peer is trusted", () => {
    expect(resolveGatewayClientAddress({
      remoteAddress: "127.0.0.1",
      forwardedFor: "203.0.113.8",
      trustedProxies: ["127.0.0.1"],
    })).toBe("203.0.113.8");

    expect(resolveGatewayClientAddress({
      remoteAddress: "127.0.0.1",
      forwardedFor: "203.0.113.8",
      trustedProxies: [],
    })).toBe("127.0.0.1");
  });

  it("uses the nearest untrusted forwarded address", () => {
    expect(resolveGatewayClientAddress({
      remoteAddress: "10.0.0.2",
      forwardedFor: "198.51.100.2, 10.0.0.1, 10.0.0.2",
      trustedProxies: ["10.0.0.0/24"],
    })).toBe("198.51.100.2");
  });

  it("requires an allowlist for public binds unless explicitly overridden", () => {
    expect(() => resolveGatewayNetworkControls({
      env: {},
      host: "0.0.0.0",
    })).toThrow("GATEWAY_IP_ALLOWLIST");

    expect(resolveGatewayNetworkControls({
      env: {GATEWAY_ALLOW_PUBLIC_WITHOUT_IP_ALLOWLIST: "true"},
      host: "0.0.0.0",
    })).toEqual({
      allowlist: [],
      trustedProxies: [],
    });
  });

  it("matches explicit IP and CIDR allowlist entries", () => {
    expect(parseGatewayIpList(" 203.0.113.8, 198.51.100.0/24 ,,")).toEqual([
      "203.0.113.8",
      "198.51.100.0/24",
    ]);
    expect(isGatewayClientAllowed("203.0.113.8", ["203.0.113.8"])).toBe(true);
    expect(isGatewayClientAllowed("198.51.100.42", ["198.51.100.0/24"])).toBe(true);
    expect(isGatewayClientAllowed("203.0.113.9", ["203.0.113.8"])).toBe(false);
  });
});
