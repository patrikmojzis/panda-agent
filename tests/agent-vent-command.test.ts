import {describe, expect, it} from "vitest";

import {
  createVentSendCommand,
  VENT_SEND_COMMAND_NAME,
} from "../src/integrations/panda-trace/vent-commands.js";

describe("agent vent command", () => {
  it("drops vent notes through vent.send when trace is not configured without echoing the message", async () => {
    const command = createVentSendCommand({
      env: {},
    });

    const result = await command.execute({
      command: VENT_SEND_COMMAND_NAME,
      input: {
        message: "private frustration",
      },
      scope: {
        agentKey: "panda",
        sessionId: "session-1",
      },
    });

    expect(result.output).toEqual({
      ok: true,
      status: "dropped",
      reason: "trace_not_configured",
      messageLength: "private frustration".length,
      traceConfigured: false,
    });
    expect(result.summary).toBe("Vent dropped because Panda Trace vent is not configured.");
    expect(result.command).toBe("vent.send");
    expect(JSON.stringify(result)).not.toContain("private frustration");
  });
});
