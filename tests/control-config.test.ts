import {describe, expect, it} from "vitest";
import {
  buildControlMcpOAuthCallbackUrl,
  DEFAULT_CONTROL_HOST,
  DEFAULT_CONTROL_PORT,
  resolveControlPublicUrl,
  resolveOptionalControlServerBinding,
} from "../src/integrations/control/config.js";

describe("Control config", () => {
  it("is disabled by default", () => {
    expect(resolveOptionalControlServerBinding({})).toBeNull();
  });

  it("binds to loopback by default when enabled", () => {
    expect(resolveOptionalControlServerBinding({PANDA_CONTROL_ENABLED: "true"})).toEqual({
      enabled: true,
      host: DEFAULT_CONTROL_HOST,
      port: DEFAULT_CONTROL_PORT,
    });
  });

  it("requires public bind to be explicit", () => {
    expect(resolveOptionalControlServerBinding({
      PANDA_CONTROL_ENABLED: "1",
      PANDA_CONTROL_HOST: "0.0.0.0",
      PANDA_CONTROL_PORT: "4768",
    })).toEqual({enabled: true, host: "0.0.0.0", port: 4768});
  });

  it("builds OAuth callbacks only from a secure canonical public URL", () => {
    expect(resolveControlPublicUrl({PANDA_CONTROL_PUBLIC_URL: "https://panda.example.test/control/"})).toBe("https://panda.example.test/control");
    expect(buildControlMcpOAuthCallbackUrl("https://panda.example.test/control")).toBe("https://panda.example.test/control/api/control/mcp/oauth/callback");
    expect(resolveControlPublicUrl({PANDA_CONTROL_PUBLIC_URL: "http://127.0.0.1:4767"})).toBe("http://127.0.0.1:4767");
    expect(() => resolveControlPublicUrl({PANDA_CONTROL_PUBLIC_URL: "http://panda.example.test"})).toThrow("must use HTTPS");
  });
});
