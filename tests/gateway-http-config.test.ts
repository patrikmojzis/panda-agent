import {describe, expect, it} from "vitest";

import {
  DEFAULT_GATEWAY_HOST,
  DEFAULT_GATEWAY_PORT,
  resolveGatewayHttpConfig,
} from "../src/integrations/gateway/http-config.js";

describe("gateway HTTP config", () => {
  it("resolves defaults and explicit env values outside the route dispatcher", () => {
    expect(resolveGatewayHttpConfig({})).toMatchObject({
      host: DEFAULT_GATEWAY_HOST,
      port: DEFAULT_GATEWAY_PORT,
      tokenTtlMs: 900_000,
      maxActiveTokensPerSource: 20,
      maxTextBytes: 65_536,
      rateLimitPerMinute: 120,
      textBytesPerHour: 5_242_880,
    });

    expect(resolveGatewayHttpConfig({
      GATEWAY_HOST: "0.0.0.0",
      GATEWAY_PORT: "8095",
      GATEWAY_ACCESS_TOKEN_TTL_MS: "1000",
      GATEWAY_MAX_ACTIVE_TOKENS_PER_SOURCE: "2",
      GATEWAY_MAX_TEXT_BYTES: "256",
      GATEWAY_RATE_LIMIT_PER_MINUTE: "3",
      GATEWAY_TEXT_BYTES_PER_HOUR: "4096",
    })).toMatchObject({
      host: "0.0.0.0",
      port: 8095,
      tokenTtlMs: 1000,
      maxActiveTokensPerSource: 2,
      maxTextBytes: 256,
      rateLimitPerMinute: 3,
      textBytesPerHour: 4096,
    });
  });

  it("rejects invalid ports before the server starts", () => {
    expect(() => resolveGatewayHttpConfig({
      GATEWAY_PORT: "70000",
    })).toThrow("Invalid gateway port: 70000.");
  });
});
