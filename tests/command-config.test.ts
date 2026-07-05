import {describe, expect, it} from "vitest";

import {buildCommandServerBaseUrl, resolveOptionalCommandServerBinding} from "../src/integrations/commands/config.js";

describe("command server config", () => {
  it("stays disabled without an explicit enable flag or socket path", () => {
    expect(resolveOptionalCommandServerBinding({})).toBeNull();
  });

  it("ignores stale static token env without enabling the server", () => {
    expect(resolveOptionalCommandServerBinding({
      PANDA_COMMAND_SERVER_TOKEN: "token-a",
      PANDA_COMMAND_SERVER_AGENT: "panda",
      PANDA_COMMAND_SERVER_SESSION: "session-main",
      PANDA_COMMAND_SERVER_ALLOW_COMMANDS: "watch.create,wiki.*",
    })).toBeNull();
  });

  it("allows dynamic-only server mode without a static token", () => {
    expect(resolveOptionalCommandServerBinding({
      PANDA_COMMAND_SERVER_ENABLED: "1",
    })).toMatchObject({
      host: "127.0.0.1",
      port: 8096,
    });
  });

  it("does not create static leases from stale token env", () => {
    const binding = resolveOptionalCommandServerBinding({
      PANDA_COMMAND_SERVER_ENABLED: "true",
      PANDA_COMMAND_SERVER_TOKEN: "token-a",
      PANDA_COMMAND_SERVER_AGENT: "panda",
      PANDA_COMMAND_SERVER_SESSION: "session-main",
      PANDA_COMMAND_SERVER_ALLOW_COMMANDS: "watch.create,wiki.*",
      PANDA_COMMAND_SERVER_PORT: "0",
      PANDA_COMMAND_SERVER_URL: "http://panda-core:8096/",
    });

    expect(binding).toMatchObject({
      host: "127.0.0.1",
      port: 0,
      publicUrl: "http://panda-core:8096/",
    });
    expect(binding).not.toHaveProperty("staticLease");
    expect(buildCommandServerBaseUrl(binding!)).toBe("http://panda-core:8096");
  });

  it("enables socket-only dynamic command server mode", () => {
    expect(resolveOptionalCommandServerBinding({
      PANDA_COMMAND_SERVER_SOCKET_PATH: "/tmp/panda-command.sock",
    })).toMatchObject({
      host: "127.0.0.1",
      port: 8096,
      socketPath: "/tmp/panda-command.sock",
    });
  });
});
