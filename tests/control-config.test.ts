import {describe, expect, it} from "vitest";
import {DEFAULT_CONTROL_HOST, DEFAULT_CONTROL_PORT, resolveOptionalControlServerBinding} from "../src/integrations/control/config.js";

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
});
